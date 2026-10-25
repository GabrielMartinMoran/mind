/**
 * Reproducible LongMemEval-S retrieval benchmark for Mind.
 * Runs the production SQLite MindStore.search() and an FTS5/BM25 baseline
 * on exactly the same per-question, session-granularity corpus.
 *
 * Usage:
 * bun benchmarks/longmemeval/run.mjs --input=/tmp/longmemeval_s_cleaned.json --count=60 --output=/tmp/results.json
 *
 * This is retrieval-only. Never report the scores as end-to-end answer accuracy.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteStore } from '../../src/store/sqlite-store.ts';

process.env.MIND_RAG = 'false';
const argv = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const input = argv.get('input') ?? '/tmp/longmemeval_s_cleaned.json';
const count = Number(argv.get('count') ?? 60);
const output = argv.get('output') ?? '/tmp/mind-longmemeval-results.json';
const topK = 20;
if (!Number.isInteger(count) || count < 1 || count > 500) {
  throw new Error('Count must be between 1 and 500.');
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const stopwords = new Set(
  'the and for with from this that what when where which who how did does have has was were are you your their they them its about into over under much many some any at to of on in as by it is be a an or'.split(' ')
);
function terms(question) {
  return [...new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((token) => !stopwords.has(token)))].slice(0, 32);
}
function selectStratified(cases, requested) {
  const types = [...new Set(cases.map((item) => item.question_type))].sort();
  const byType = new Map(types.map((type) => [
    type,
    cases.filter((item) => item.question_type === type).sort((a, b) =>
      digest('mind-longmemeval-s-v1:' + a.question_id)
        .localeCompare(digest('mind-longmemeval-s-v1:' + b.question_id))
    ),
  ]));
  const selected = [];
  let level = 0;
  while (selected.length < requested) {
    let added = 0;
    for (const type of types) {
      const next = byType.get(type)[level];
      if (next && selected.length < requested) {
        selected.push(next);
        added += 1;
      }
    }
    if (added === 0) break;
    level += 1;
  }
  return selected;
}
const fraction = (numerator, denominator) => denominator ? numerator / denominator : null;
function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)))];
}

const fullDataset = await Bun.file(input).json();
if (!Array.isArray(fullDataset) || fullDataset.length !== 500) {
  throw new Error('Expected the official 500-item LongMemEval-S dataset.');
}
const selected = selectStratified(fullDataset, count);
const workdir = join(tmpdir(), 'mind-longmemeval-' + process.pid);
mkdirSync(workdir, { recursive: true });

function score(row, name) {
  const predicted = row[name];
  const relevant = row.gold;
  if (!relevant.length) return null;
  const seen = new Set(predicted);
  const found = relevant.filter((id) => seen.has(id)).length;
  const first = predicted.findIndex((id) => relevant.includes(id));
  return {
    hit: found > 0 ? 1 : 0,
    all: found === relevant.length ? 1 : 0,
    evidenceRecall: found / relevant.length,
    mrr: first < 0 ? 0 : 1 / (first + 1),
  };
}
function summarize(rows, key) {
  const judged = rows.map((row) => score(row, key)).filter(Boolean);
  return {
    evaluated: judged.length,
    hitAt20: fraction(judged.reduce((a, b) => a + b.hit, 0), judged.length),
    allEvidenceAt20: fraction(judged.reduce((a, b) => a + b.all, 0), judged.length),
    evidenceRecallAt20: fraction(judged.reduce((a, b) => a + b.evidenceRecall, 0), judged.length),
    mrrAt20: fraction(judged.reduce((a, b) => a + b.mrr, 0), judged.length),
  };
}

const records = [];
try {
  for (let index = 0; index < selected.length; index += 1) {
    const example = selected[index];
    const dbPath = join(workdir, 'case.sqlite');
    const store = createSqliteStore(dbPath);
    const sessionIds = example.haystack_session_ids;
    const sessions = example.haystack_sessions;
    const dates = example.haystack_dates;
    if (sessionIds.length !== sessions.length || dates.length !== sessions.length) {
      throw new Error('Misaligned haystack at ' + example.question_id);
    }

    try {
      store.createSpace('longmemeval', 'LongMemEval session memories');
      const keyToGold = new Map();
      const startIngest = performance.now();
      for (let i = 0; i < sessions.length; i += 1) {
        const name = 'session-' + String(i).padStart(3, '0');
        keyToGold.set(name, String(sessionIds[i]));
        const body = sessions[i].map((turn) =>
          String(turn.role ?? 'unknown') + ': ' + String(turn.content ?? '')
        ).join('\n\n');
        const content = 'Session date: ' + String(dates[i]) + '\n' + body;
        await store.addMemory('longmemeval', name, content, { tier: 3 });
      }
      const ingestMs = performance.now() - startIngest;
      const startSearch = performance.now();
      const ranked = await store.search(example.question, {
        space: 'longmemeval',
        limit: topK,
        semantic: false,
      });
      const mindMs = performance.now() - startSearch;
      const mind = ranked.map((item) => keyToGold.get(item.name)).filter(Boolean);

      // Independent, deliberately simple no-LLM baseline over the same FTS index.
      const baseDb = new Database(dbPath, { readonly: true });
      let bm25 = [];
      const query = terms(example.question).map((token) => '"' + token + '"').join(' OR ');
      const startBaseline = performance.now();
      try {
        if (query) {
          const matches = baseDb.prepare(`
            SELECT m.name AS name
            FROM memories_fts f
            JOIN memories m ON m.fts_id = f.rowid
            WHERE memories_fts MATCH ?
            ORDER BY bm25(memories_fts) ASC LIMIT ?
          `).all(query, topK);
          bm25 = matches.map((item) => keyToGold.get(item.name)).filter(Boolean);
        }
      } finally {
        baseDb.close();
      }
      const bm25Ms = performance.now() - startBaseline;
      const row = {
        id: example.question_id,
        type: example.question_type,
        isAbstention: example.question_id.endsWith('_abs'),
        sessionCount: sessions.length,
        gold: (example.answer_session_ids ?? []).map(String),
        mind,
        bm25,
        ingestMs,
        mindMs,
        bm25Ms,
      };
      records.push(row);
      if ((index + 1) % 10 === 0 || index + 1 === selected.length) {
        console.log('PROGRESS ' + (index + 1) + '/' + selected.length
          + ' mindHit@20=' + String(summarize(records, 'mind').hitAt20));
      }
    } finally {
      store.close();
      for (const ext of ['', '-shm', '-wal']) {
        rmSync(dbPath + ext, { force: true });
      }
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const answerable = records.filter((row) => !row.isAbstention && row.gold.length > 0);
const byCategory = Object.fromEntries(
  [...new Set(answerable.map((row) => row.type))].sort().map((type) => {
    const sample = answerable.filter((row) => row.type === type);
    return [type, { mind: summarize(sample, 'mind'), bm25: summarize(sample, 'bm25') }];
  })
);
const report = {
  benchmark: 'LongMemEval-S cleaned (2025-09)',
  protocol: 'per-question isolated corpus; one memory per entire session; direct evidence session-id matching; lexical RAG OFF',
  datasetSha256: digest(Buffer.from(await Bun.file(input).arrayBuffer())),
  count: records.length,
  answerableCount: answerable.length,
  abstentionCount: records.length - answerable.length,
  topK,
  mind: summarize(answerable, 'mind'),
  bm25: summarize(answerable, 'bm25'),
  byCategory,
  timingsMs: {
    mindP50: percentile(records.map((row) => row.mindMs), 0.5),
    mindP95: percentile(records.map((row) => row.mindMs), 0.95),
    bm25P50: percentile(records.map((row) => row.bm25Ms), 0.5),
    ingestP50: percentile(records.map((row) => row.ingestMs), 0.5),
  },
  perQuestion: records,
};
mkdirSync(resolve(output, '..'), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('BENCHMARK_RESULT ' + JSON.stringify({
  benchmark: report.benchmark,
  datasetSha256: report.datasetSha256,
  count: report.count,
  answerableCount: report.answerableCount,
  mind: report.mind,
  bm25: report.bm25,
  timingsMs: report.timingsMs,
}));
