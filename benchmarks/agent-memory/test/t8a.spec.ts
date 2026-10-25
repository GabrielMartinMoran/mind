// T8a tests — per-question DB isolation wiring, repetitions, category
// aggregation and baseline-delta math. All offline except the gated
// integration test (BENCH_INTEGRATION=1), which uses real SQLite copies.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { emptyA2Outcome, runA2, type A2UnitExecutor, type A2UnitJob } from '../src/benchmarkA/a2';
import { groupCandidates, runA2Command } from '../src/benchmarkA/command';
import { measurementKey, type A2QuestionResult } from '../src/benchmarkA/judge';
import { BudgetGuard } from '../src/budget';
import type { ConditionId } from '../src/config';
import { applyMindDatabase, buildOpenCodeEnv, isolationDirs } from '../src/isolation/opencode';
import { aggregateA2, buildSummary } from '../src/metrics/aggregate';
import type { ConditionProfile } from '../src/opencode/conditions';
import { copyMindDatabaseForQuestion } from '../src/opencode/conditions';
import { hostCreateOptions } from '../src/opencode/driver';

import { makeA2, makeMeta } from './fixtures/bench-run';

const GATED = process.env.BENCH_INTEGRATION === '1';
const gatedTest = GATED ? test : test.skip;

// ── 3a — per-question DB isolation wiring ────────────────────────────────────

describe('applyMindDatabase', () => {
  test('rewires both the child env and the mind MCP server environment', () => {
    const dir = isolationDirs('/run/mind-v10');
    const env = buildOpenCodeEnv({ condition: 'mind-v10', dir, mindBin: '/wt/mind' });
    const copy = '/run/mind-v10/a2/conv-26_1/rep-0/mind.db';
    const dataDir = '/run/mind-v10/a2/conv-26_1/rep-0';
    const applied = applyMindDatabase(env, {
      dbPath: copy,
      dataDir,
      syncRoot: `${dataDir}/syncroot`,
    });

    expect(applied.MIND_DB_PATH).toBe(copy);
    expect(applied.MIND_DATA_DIR).toBe(dataDir);

    const cfg = JSON.parse(applied.OPENCODE_CONFIG_CONTENT!) as {
      mcp: { servers: { mind: { environment: Record<string, string> } } };
    };
    expect(cfg.mcp.servers.mind.environment.MIND_DB_PATH).toBe(copy);
    expect(cfg.mcp.servers.mind.environment.MIND_DATA_DIR).toBe(dataDir);
    // The pinned model is preserved.
    expect(applied.OPENCODE_CONFIG_CONTENT).toContain('"model"');
  });

  test('binds the embedded SDK host to the unit own OPENCODE_DB path', () => {
    const unitA = isolationDirs('/run/mind-v10/a2/conv-26_1/rep-0');
    const unitB = isolationDirs('/run/mind-v10/a2/conv-26_1/rep-1');
    const envA = buildOpenCodeEnv({ condition: 'mind-v10', dir: unitA, mindBin: '/wt/mind' });
    const envB = buildOpenCodeEnv({ condition: 'mind-v10', dir: unitB, mindBin: '/wt/mind' });

    expect(envA.OPENCODE_DB).toBe(unitA.opencodeDb);
    expect(hostCreateOptions(envA)?.database?.path).toBe(unitA.opencodeDb);
    expect(hostCreateOptions(envB)?.database?.path).toBe(unitB.opencodeDb);
    expect(unitA.opencodeDb).not.toBe(unitB.opencodeDb);
  });

  test('leaves a no-memory config without a mind server intact', () => {
    const dir = isolationDirs('/run/no-memory');
    const env = buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null });
    const applied = applyMindDatabase(env, {
      dbPath: '/x/mind.db',
      dataDir: '/x',
      syncRoot: '/x/syncroot',
    });
    const cfg = JSON.parse(applied.OPENCODE_CONFIG_CONTENT!) as { mcp?: unknown };
    expect(cfg.mcp).toBeUndefined();
    expect(applied.MIND_DB_PATH).toBe('/x/mind.db');
  });
});

// ── 3b — repetitions ─────────────────────────────────────────────────────────

function profile(condition: ConditionId, runDir: string): ConditionProfile {
  return {
    id: condition,
    engine: condition === 'no-memory' ? null : condition === 'mind-v10' ? 'v10' : 'v9',
    dirs: isolationDirs(join(runDir, condition)),
    env: { OPENCODE_CONFIG_CONTENT: '{}' },
    mindBin: condition === 'no-memory' ? null : '/wt/mind',
  };
}

function captureExecutor(seen: A2UnitJob[]): A2UnitExecutor {
  return async job => {
    seen.push(job);
    return { ...emptyA2Outcome('ok', null), answer: 'a', costUsd: 0.001, latencyMs: 5 };
  };
}

const subset2 = [
  {
    id: 'conv-26#1',
    sampleId: 'conv-26',
    questionIndex: 1,
    category: 1 as const,
    categoryName: 'multi-hop',
    question: 'q1',
    answer: 'a1',
    evidence: ['D1:1'],
    adversarial: false,
  },
  {
    id: 'conv-26#2',
    sampleId: 'conv-26',
    questionIndex: 2,
    category: 4 as const,
    categoryName: 'single-hop',
    question: 'q2',
    answer: 'a2',
    evidence: ['D2:1'],
    adversarial: false,
  },
];

describe('runA2 repetitions', () => {
  test('produces one measurement per (question, rep) with rep-tagged results and means', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-reps-'));
    const conditions: ConditionId[] = ['no-memory', 'mind-v10'];
    for (const c of conditions) mkdirSync(join(runDir, c), { recursive: true });

    const seen: A2UnitJob[] = [];
    const run = await runA2(
      {
        runId: 'run-reps',
        runDir,
        conditions,
        subset: subset2,
        limits: { steps: 3, timeoutMs: 1000 },
        reps: 2,
        budget: new BudgetGuard({ maxCostUsd: 5 }),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      {
        profiles: Object.fromEntries(conditions.map(c => [c, profile(c, runDir)])),
        sourceDb: { 'mind-v10': '/fake/v10.db' },
        executor: captureExecutor(seen),
        copyDb: () => ({ sha256: 'deadbeef' }),
      }
    );

    // 2 conditions × 2 questions × 2 reps.
    expect(seen).toHaveLength(8);
    expect(run.results).toHaveLength(8);
    expect(new Set(run.results.map(r => r.rep)).size).toBe(2);

    // Independent unit dir per rep, and the mind-v10 job env points at its copy.
    const mindJobs = seen.filter(j => j.condition === 'mind-v10');
    const dirs = new Set(mindJobs.map(j => j.unitDir));
    expect(dirs.size).toBe(4);
    for (const job of mindJobs) {
      expect(job.mindDbPath).toBe(join(job.unitDir, 'mind.db'));
      expect(job.env.MIND_DB_PATH).toBe(job.mindDbPath!);
      // Per-unit workspace, not the shared condition workspace.
      expect(job.workspaceDir.startsWith(job.unitDir)).toBe(true);
    }
    expect(new Set(mindJobs.map(j => j.workspaceDir)).size).toBe(4);
    // no-memory has no mind database.
    expect(seen.filter(j => j.condition === 'no-memory').every(j => j.mindDbPath === null)).toBe(
      true
    );

    // Per-condition file holds the rep-tagged entries; means file exists.
    const v10 = JSON.parse(readFileSync(join(runDir, 'results', 'a2-mind-v10.json'), 'utf8'));
    expect(v10).toHaveLength(4);
    const means = JSON.parse(
      readFileSync(join(runDir, 'results', 'a2-mind-v10-means.json'), 'utf8')
    );
    expect(means).toHaveLength(4);

    const v10agg = run.aggregates.find(a => a.condition === 'mind-v10')!;
    expect(v10agg.reps).toBe(2);
    expect(v10agg.questionCount).toBe(2);
    // 8 paid measurements (2 conditions × 2Q × 2 reps) × $0.001.
    expect(run.spentUsd).toBeCloseTo(0.008, 6);
  });
});

describe('measurementKey', () => {
  test('is unique per (question, rep)', () => {
    expect(measurementKey({ id: 'q1', rep: 0 })).toBe('q1::rep0');
    expect(measurementKey({ id: 'q1', rep: 2 })).toBe('q1::rep2');
    expect(measurementKey({ id: 'q1' })).toBe('q1::rep0');
  });
});

describe('groupCandidates per (question, rep)', () => {
  test('groups rep-tagged answers into separate candidate sets', () => {
    const results = [
      { ...makeA2('mind-v10', 'conv-26#1', 'correct', { judgeScore: 1 }), rep: 0 },
      { ...makeA2('mind-v9', 'conv-26#1', 'partial', { judgeScore: 0.5 }), rep: 0 },
      { ...makeA2('mind-v10', 'conv-26#1', 'incorrect', { judgeScore: 0 }), rep: 1 },
      { ...makeA2('mind-v9', 'conv-26#1', 'correct', { judgeScore: 1 }), rep: 1 },
    ] as A2QuestionResult[];
    const questions = groupCandidates(results, subset2.slice(0, 1));
    expect(questions.map(q => q.key)).toEqual(['conv-26#1::rep0', 'conv-26#1::rep1']);
    expect(questions[0]!.candidates.map(c => c.condition)).toEqual(['mind-v10', 'mind-v9']);
    expect(questions[1]!.candidates.map(c => c.condition)).toEqual(['mind-v10', 'mind-v9']);
  });
});

// ── 3c — category aggregation + baseline delta ───────────────────────────────

function a2(
  condition: ConditionId,
  id: string,
  category: number,
  opts: { f1?: number | null; judgeScore?: number | null; rep?: number } = {}
): A2QuestionResult {
  const base = makeA2(condition, id, 'correct', {
    f1: opts.f1 ?? null,
    judgeScore: opts.judgeScore ?? null,
  });
  return {
    ...base,
    category,
    categoryName: category === 5 ? 'adversarial' : 'multi-hop',
    adversarial: category === 5,
    rep: opts.rep ?? 0,
  };
}

describe('aggregateA2 category breakdown', () => {
  test('groups by dataset category and ignores absent categories', () => {
    const summary = aggregateA2([
      a2('mind-v10', 'q1', 1, { f1: 1, judgeScore: 1 }),
      a2('mind-v10', 'q2', 1, { f1: 0, judgeScore: 0 }),
      a2('mind-v10', 'q3', 5, { judgeScore: 0.5 }),
    ]);
    expect(Object.keys(summary.perCategory).sort()).toEqual(['1', '5']);
    expect(summary.perCategory['1']!.count).toBe(2);
    expect(summary.perCategory['1']!.f1Mean).toBeCloseTo(0.5, 10);
    expect(summary.perCategory['5']!.judgeScoreMean).toBe(0.5);
    expect(summary.perCategory['5']!.f1Mean).toBeNull();
    expect(summary.perCategory['2']).toBeUndefined();
  });

  test('reports the number of distinct reps', () => {
    const summary = aggregateA2([
      a2('mind-v10', 'q1', 1, { rep: 0 }),
      a2('mind-v10', 'q1', 1, { rep: 1 }),
    ]);
    expect(summary.reps).toBe(2);
  });
});

describe('buildA2Baseline delta math', () => {
  const base = {
    runId: 'run-delta',
    meta: makeMeta(),
    a1: {},
    b: {},
    missing: [],
  };

  test('emits absolute + non-zero-relative deltas and N/A passthrough', () => {
    const summary = aggregateA2([a2('mind-v10', 'q1', 1, { f1: 0.5, judgeScore: 0.5 })]);
    const built = buildSummary({
      ...base,
      a2: {
        'no-memory': [a2('no-memory', 'q1', 1, { f1: 0, judgeScore: 0 })],
        'mind-v10': [a2('mind-v10', 'q1', 1, { f1: 0.5, judgeScore: 0.5 })],
      },
    });
    const judge = built.diffs.a2Baseline.find(
      row =>
        row.condition === 'mind-v10' && row.scope === 'overall' && row.metric === 'judgeScoreMean'
    )!;
    expect(judge.baseline).toBe(0);
    expect(judge.value).toBe(0.5);
    expect(judge.absolute).toBeCloseTo(0.5, 10);
    expect(judge.relative).toBeNull(); // zero baseline → relative N/A

    const cat = built.diffs.a2Baseline.find(
      row =>
        row.condition === 'mind-v10' && row.scope === 'multi-hop' && row.metric === 'judgeScoreMean'
    )!;
    expect(cat.scope).toBe('multi-hop');
    expect(cat.baseline).toBe(0);
    expect(cat.value).toBe(0.5);
    expect(cat.absolute).toBeCloseTo(0.5, 10);

    // sanity: summary unused but must be a valid A2Summary shape
    expect(summary.perCategory['1']).toBeDefined();
  });

  test('computes a real relative delta when the baseline is non-zero', () => {
    const built = buildSummary({
      ...base,
      a2: {
        'no-memory': [a2('no-memory', 'q1', 1, { f1: 0.4, judgeScore: 0.4 })],
        'mind-v10': [a2('mind-v10', 'q1', 1, { f1: 0.6, judgeScore: 0.6 })],
      },
    });
    const judge = built.diffs.a2Baseline.find(
      row =>
        row.condition === 'mind-v10' && row.scope === 'overall' && row.metric === 'judgeScoreMean'
    )!;
    expect(judge.baseline).toBeCloseTo(0.4, 10);
    expect(judge.value).toBeCloseTo(0.6, 10);
    expect(judge.absolute).toBeCloseTo(0.2, 10);
    // (0.6 - 0.4) / 0.4 = 0.5
    expect(judge.relative).not.toBeNull();
    expect(judge.relative!).toBeCloseTo(0.5, 10);
  });
});

// ── gated integration — real per-question DB copies ──────────────────────────

describe('per-question DB isolation (integration)', () => {
  gatedTest(
    'creates one distinct WAL-safe copy per (question, rep) and points the job at it',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'bench-isofix-'));
      const runDir = join(root, 'run');
      const source = join(root, 'source', 'mind.db');
      mkdirSync(join(root, 'source'), { recursive: true });
      const db = new Database(source);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, name TEXT)');
      const insert = db.prepare('INSERT INTO memories (name) VALUES (?)');
      for (let i = 0; i < 5; i++) insert.run(`D${i}:0`);
      db.close();

      const conditions: ConditionId[] = ['mind-v10'];
      mkdirSync(join(runDir, 'mind-v10'), { recursive: true });
      const seen: string[] = [];
      const workspaces: string[] = [];
      const run = await runA2(
        {
          runId: 'run-iso',
          runDir,
          conditions,
          subset: subset2,
          limits: { steps: 1, timeoutMs: 1000 },
          reps: 2,
          budget: new BudgetGuard({ maxCostUsd: 5 }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
        {
          profiles: { 'mind-v10': profile('mind-v10', runDir) },
          sourceDb: { 'mind-v10': source },
          copyDb: copyMindDatabaseForQuestion,
          executor: async job => {
            expect(job.mindDbPath).not.toBeNull();
            expect(existsSync(job.mindDbPath!)).toBe(true);
            expect(existsSync(job.workspaceDir)).toBe(true);
            seen.push(job.mindDbPath!);
            workspaces.push(job.workspaceDir);
            return { ...emptyA2Outcome('ok', null), answer: 'a' };
          },
        }
      );

      // 2 questions × 2 reps = 4 distinct copies.
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      expect(new Set(workspaces).size).toBe(4);
      for (const path of seen) expect(existsSync(path)).toBe(true);
      expect(run.results.every(r => r.rep !== undefined)).toBe(true);
    }
  );
});

describe('judge stage preserves answering aggregates metadata', () => {
  test('keeps temperatureRequested and reps when rewriting a2-aggregates.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-merge-'));
    const runsRoot = join(root, 'runs');
    const runDir = join(runsRoot, 'run-merge');
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify({ runId: 'run-merge', stages: {}, limits: { sessionSteps: 1, timeoutMs: 1000 } })}\n`,
      'utf8'
    );
    writeFileSync(join(runDir, 'subset.json'), `${JSON.stringify({ items: subset2 })}\n`, 'utf8');
    for (const condition of ['mind-v10'] as ConditionId[]) {
      writeFileSync(
        join(runDir, 'results', `a2-${condition}.json`),
        `${JSON.stringify([
          { ...makeA2(condition, 'conv-26#1', 'correct', { judgeScore: 1 }), rep: 0 },
        ])}\n`,
        'utf8'
      );
    }
    writeFileSync(
      join(runDir, 'results', 'a2-aggregates.json'),
      `${JSON.stringify({ temperatureRequested: 0, reps: 3, aggregates: [] })}\n`,
      'utf8'
    );

    const driver = {
      async runPrompt() {
        return {
          sessionId: 's',
          finalText: '{"verdicts":[{"candidate":1,"class":"correct","score":1}],"reason":""}',
          assistantTexts: [],
          toolCalls: [],
          memoryCalls: 0,
          model: null,
          costUsd: 0,
          tokens: null,
          steps: 1,
          latencyMs: 1,
          finish: 'stop',
          error: null,
        };
      },
      async children() {
        return [];
      },
      async rawMessages() {
        return { data: [] };
      },
      async close() {},
    };

    const code = await runA2Command(
      {
        runId: 'run-merge',
        runsRoot: 'runs',
        workRoot: 'work',
        conditions: ['mind-v10'],
        budgetUsd: 5,
        judgeOnly: true,
      },
      {
        repoRoot: root,
        runner: async inv => ({ ...inv, stdout: '', stderr: '', exitCode: 0 }),
        stdout: () => undefined,
        stderr: () => undefined,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
      }
    );
    expect(code).toBe(0);
    const merged = JSON.parse(
      readFileSync(join(runDir, 'results', 'a2-aggregates.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(merged.temperatureRequested).toBe(0);
    expect(merged.reps).toBe(3);
    expect(Array.isArray(merged.aggregates)).toBe(true);
  });
});
