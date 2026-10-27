#!/usr/bin/env bun
// ── Search evaluation runner ──
//
// Usage:
//   bun run scripts/search-eval.ts --mode fixture [--out <base>] [--k <n>]
//   bun run scripts/search-eval.ts --mode real --db <copy.db> [--out <base>]
//   bun run scripts/search-eval.ts --gen-real-cases --db <copy.db> --out <file>
//
// Fixture mode builds a throwaway store from the committed corpus. Real mode
// only ever opens a COPY of the real database, in strict read-only mode.

// Fixture and real modes must be deterministic and offline: force RAG off
// BEFORE importing any module that reads CONFIG at import time (config.ts).
process.env.MIND_RAG = 'false';

import type { RealCase, RealCasesFile } from '../test/search-eval/types';

const DEFAULT_REAL_CASES = new URL('../test/search-eval/cases.real.json', import.meta.url);

interface Args {
  mode: string | null;
  db: string | null;
  out: string | null;
  k: number | null;
  baseline: string | null;
  genRealCases: boolean;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} expects a positive integer, got: ${raw}`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: null,
    db: null,
    out: null,
    k: null,
    baseline: null,
    genRealCases: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`Missing value for ${token}`);
      return value;
    };
    switch (token) {
      case '--mode':
        args.mode = next();
        break;
      case '--db':
        args.db = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--k':
        args.k = parsePositiveInt(next(), '--k');
        break;
      case '--baseline':
        args.baseline = next();
        break;
      case '--gen-real-cases':
        args.genRealCases = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

async function writeReport(outBase: string, json: unknown, markdown: string): Promise<void> {
  const jsonPath = outBase.endsWith('.json') ? outBase : `${outBase}.json`;
  const mdPath = jsonPath.replace(/\.json$/, '') + '.md';
  await Bun.write(jsonPath, JSON.stringify(json, null, 2) + '\n');
  await Bun.write(mdPath, markdown + '\n');
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

/** Render the v2 fixture run summary (metrics + ranking) as plain text. */
function renderV2Summary(report: {
  case_count: number;
  errored_cases: number;
  ranking: { mrr: number; ndcg_at_10: number; relevant_cases: number; cases: number };
  metrics: {
    overall: {
      cases: number;
      passed: number;
      avgPrecision: number;
      avgRecall: number;
      tp: number;
      fp: number;
      fn: number;
      noiseRate: number;
      negatives: number;
    };
  };
}): string {
  const overall = report.metrics.overall;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return [
    'Search evaluation — fixture suite v2',
    `cases: ${report.case_count}  errored: ${report.errored_cases}`,
    `passed: ${overall.passed}/${overall.cases}  P@k: ${pct(overall.avgPrecision)}  R@k: ${pct(overall.avgRecall)}  TP: ${overall.tp}  FP: ${overall.fp}  FN: ${overall.fn}`,
    `MRR: ${report.ranking.mrr.toFixed(4)}  nDCG@10: ${report.ranking.ndcg_at_10.toFixed(4)}  (relevant cases: ${report.ranking.relevant_cases}/${report.ranking.cases})`,
  ].join('\n');
}

async function loadRealCases(path: string): Promise<RealCase[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Real cases file not found: ${path}. Generate it with --gen-real-cases --db <copy.db>.`
    );
  }
  const parsed = (await file.json()) as RealCasesFile;
  return parsed.cases;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.genRealCases) {
    if (!args.db) throw new Error('--gen-real-cases requires --db <copy.db>');
    if (!args.out) throw new Error('--gen-real-cases requires --out <file>');
    const { buildRealCasesFile } = await import('../test/search-eval/real-cases');
    const data = buildRealCasesFile(args.db);
    await Bun.write(args.out, JSON.stringify(data, null, 2) + '\n');
    console.log(`Wrote ${args.out} (${data.cases.length} real cases)`);
    return;
  }

  if (args.mode === 'fixture') {
    const [{ runFixture }, { renderSummaryTable }] = await Promise.all([
      import('../test/search-eval/evaluator'),
      import('../test/search-eval/report'),
    ]);
    const { snapshot, report } = await runFixture(args.k === null ? {} : { defaultK: args.k });
    console.log(renderSummaryTable(report));
    console.log(`\nsnapshot hash: ${snapshot.hash}`);
    if (args.baseline) {
      await Bun.write(args.baseline, JSON.stringify(snapshot, null, 2) + '\n');
      console.log(`Wrote baseline ${args.baseline}`);
    }
    if (args.out) {
      await writeReport(args.out, snapshot, renderSummaryTable(report));
    }
    return;
  }

  if (args.mode === 'fixture-v2') {
    const { runFixtureV2 } = await import('../test/search-eval/evaluator');
    const { snapshot, report } = await runFixtureV2(args.k === null ? {} : { defaultK: args.k });
    console.log(renderV2Summary(report));
    console.log(`\nsnapshot hash: ${snapshot.hash}`);
    if (args.baseline) {
      await Bun.write(args.baseline, JSON.stringify(snapshot, null, 2) + '\n');
      console.log(`Wrote baseline ${args.baseline}`);
    }
    if (args.out) {
      await writeReport(args.out, snapshot, renderV2Summary(report));
    }
    return;
  }

  if (args.mode === 'real') {
    if (!args.db)
      throw new Error('--mode real requires --db <copy.db> (never the live data/mind.db)');
    const [{ runReal }, { renderRealSummary }] = await Promise.all([
      import('../test/search-eval/evaluator'),
      import('../test/search-eval/report'),
    ]);
    const realPath = DEFAULT_REAL_CASES.pathname;
    const cases = await loadRealCases(realPath);
    const realReport = await runReal(args.db, cases);
    console.log(renderRealSummary(realReport));
    if (args.out) {
      await writeReport(args.out, realReport, renderRealSummary(realReport));
    }
    return;
  }

  throw new Error('Specify --mode fixture|real or --gen-real-cases');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
