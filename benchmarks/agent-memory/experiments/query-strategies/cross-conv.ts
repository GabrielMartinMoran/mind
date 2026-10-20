// Experiment A — cross-conversation validation.
//
// Checks that the E-A winner (S2, conservative stopword drop) generalizes to a
// second LoCoMo conversation. It ingests one conversation into a FRESH temp DB
// with the same deterministic transformation the benchmark used
// (`conversationTurns`: one memory per turn, name=dia_id,
// content=`[date] speaker: text`, tags `locomo`+`session:N`, tier 3), then runs
// S1 vs S2 over that conversation's answerable questions with gold from its qa.
//
// Free, local, RAG-off; the benchmark DBs are never touched.
//
// Usage:
//   bun run experiments/query-strategies/cross-conv.ts [--conversation conv-44]
//     [--worktree <dir>] [--locomo <json>] [--scratch <dir>] [--out <json>]
//     [--append <report.md>]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { conversationTurns } from '../../src/locomo/ingest';
import type { LocomoDataset } from '../../src/locomo/types';
import { MindCli } from '../../src/mind/cli';
import {
  DEFAULT_SPACE,
  buildEnv,
  findFreePort,
  mapSearchItems,
  startServer,
  type ReplayChunk,
} from '../replay/replay';

import {
  computeCrossConvGains,
  computeMetrics,
  renderCrossConvSection,
  unionChunks,
  upsertSection,
  type CrossConvResult,
  type StrategyExecution,
  type StrategyMetrics,
} from './run';
import { applyStrategy, type StrategyId } from './strategies';

async function search(
  baseUrl: string,
  query: string,
  space: string,
  limit: number
): Promise<{ chunks: ReplayChunk[]; latencyMs: number }> {
  const params = new URLSearchParams({ q: query, space, limit: String(limit) });
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`/api/search status ${response.status}`);
  const items = (await response.json()) as unknown;
  return { chunks: mapSearchItems(items), latencyMs: performance.now() - started };
}

async function execute(
  baseUrl: string,
  space: string,
  id: StrategyId,
  question: string,
  participants: readonly string[],
  limit: number
): Promise<StrategyExecution> {
  const result = applyStrategy(id, question, { participants });
  const lists: ReplayChunk[][] = [];
  let latencyMs = 0;
  for (const query of result.queries) {
    const item = await search(baseUrl, query, space, limit);
    lists.push(item.chunks);
    latencyMs += item.latencyMs;
  }
  const chunks = unionChunks(lists, limit);
  return {
    queries: result.queries,
    rewritten: result.rewritten,
    reason: result.reason,
    ranked_refs: chunks.map(chunk => chunk.name),
    ranked_contents: chunks.map(chunk => chunk.content),
    result_count: chunks.length,
    latency_ms: latencyMs,
  };
}

interface Options {
  conversation: string;
  worktree: string;
  locomo: string;
  scratch: string;
  out: string;
  append: string | null;
  limit: number;
}

function defaultOptions(): Options {
  const agentMemory = resolve(import.meta.dir, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    conversation: 'conv-44',
    worktree: join(agentMemory, '.work/worktrees/v10'),
    locomo: join(integration, 'data/locomo10.json'),
    scratch: join(agentMemory, '.work/experiments/cross-conv'),
    out: join(import.meta.dir, '..', 'REPORTS', 'query-strategies', 'cross-conv.json'),
    append: join(import.meta.dir, '..', 'REPORTS', 'query-strategies', 'report.md'),
    limit: 10,
  };
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const base = defaultOptions();
  return {
    conversation: flags.get('conversation') ?? base.conversation,
    worktree: flags.get('worktree') ?? base.worktree,
    locomo: flags.get('locomo') ?? base.locomo,
    scratch: flags.get('scratch') ?? base.scratch,
    out: flags.get('out') ?? base.out,
    append: flags.get('append') === 'none' ? null : (flags.get('append') ?? base.append),
    limit: Number(flags.get('limit') ?? base.limit),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dataset = JSON.parse(readFileSync(options.locomo, 'utf8')) as LocomoDataset;
  const turns = conversationTurns(dataset, options.conversation);
  if (turns.length === 0) throw new Error(`no turns for ${options.conversation}`);

  const scratchDir = resolve(options.scratch, options.conversation);
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  const cli = new MindCli({
    bin: join(resolve(options.worktree), 'mind'),
    paths: {
      dataDir: scratchDir,
      dbPath: join(scratchDir, 'mind.db'),
      syncRoot: join(scratchDir, 'syncroot'),
    },
    cwd: resolve(options.worktree),
  });
  const started = performance.now();
  await cli.exec(['create', DEFAULT_SPACE, `LoCoMo ${DEFAULT_SPACE}`, '--tags', 'locomo']);
  for (const turn of turns) {
    await cli.exec([
      'add',
      DEFAULT_SPACE,
      turn.diaId,
      turn.content,
      '--tags',
      turn.tags.join(','),
      '--tier',
      '3',
    ]);
  }
  const ingestMs = performance.now() - started;

  const env = buildEnv(scratchDir, 'off');
  const port = await findFreePort();
  const server = await startServer({
    bin: join(resolve(options.worktree), 'mind'),
    cwd: resolve(options.worktree),
    env,
    port,
    stderrLog: join(scratchDir, 'serve.stderr.log'),
  });

  try {
    const sample = dataset.find(entry => entry.sample_id === options.conversation);
    if (!sample) throw new Error(`conversation ${options.conversation} not found`);
    // Answerable = non-adversarial (category != 5); evidence from its own qa.
    const qa = sample.qa.filter(item => item.category !== 5 && (item.evidence?.length ?? 0) > 0);
    const participants = [sample.conversation.speaker_a, sample.conversation.speaker_b].filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    );

    const ids = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as StrategyId[];
    const execs: Record<StrategyId, StrategyExecution[]> = {
      S1: [],
      S2: [],
      S3: [],
      S4: [],
      S5: [],
      S6: [],
    };
    const golds: string[][] = [];
    for (const item of qa) {
      golds.push([...(item.evidence ?? [])]);
      for (const id of ids) {
        execs[id].push(
          await execute(
            server.baseUrl,
            DEFAULT_SPACE,
            id,
            item.question,
            participants,
            options.limit
          )
        );
      }
    }

    const metrics: Record<string, StrategyMetrics> = {};
    for (const id of ids) {
      metrics[id] = computeMetrics(execs[id], golds, 10);
    }
    const s1 = metrics.S1!;
    const s2 = metrics.S2!;
    const result: CrossConvResult = {
      conversation: options.conversation,
      space: DEFAULT_SPACE,
      turns: turns.length,
      answerable_questions: qa.length,
      strategies: metrics,
      s1_vs_s2: computeCrossConvGains(s1, s2),
    };

    const outPath = resolve(options.out);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

    if (options.append) {
      const reportPath = resolve(options.append);
      const section = renderCrossConvSection(result);
      const existing = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
      writeFileSync(reportPath, upsertSection(existing, section));
    }

    process.stdout.write(
      `cross-conv ${options.conversation}: ${turns.length} turns (${Math.round(ingestMs)} ms), ` +
        `${qa.length} questions; ` +
        `S1 full=${s1.full_evidence_at_10?.toFixed(3)} hit=${s1.hit_at_10?.toFixed(3)}; ` +
        `S2 full=${s2.full_evidence_at_10?.toFixed(3)} hit=${s2.hit_at_10?.toFixed(3)}\n`
    );
  } finally {
    await server.stop();
  }
}

if (import.meta.main) await main();
