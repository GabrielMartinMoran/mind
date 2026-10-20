import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
  A2_PROMPT_TEMPLATE,
  buildA2Prompt,
  emptyA2Outcome,
  runA2,
  type A2UnitExecutor,
  type A2UnitJob,
} from '../src/benchmarkA/a2';
import { BudgetExceededError, BudgetGuard } from '../src/budget';
import type { ConditionId } from '../src/config';
import { isolationDirs } from '../src/isolation/opencode';
import { copyMindDatabaseForQuestion } from '../src/opencode/conditions';
import type { ConditionProfile } from '../src/opencode/conditions';
import { createFakeSessionDriver, type FakeSessionScript } from '../src/testing/fakes';

function profile(condition: ConditionId, runDir: string): ConditionProfile {
  return {
    id: condition,
    engine: condition === 'no-memory' ? null : condition === 'mind-v9' ? 'v9' : 'v10',
    dirs: isolationDirs(join(runDir, condition)),
    env: { OPENCODE_CONFIG_CONTENT: '{}' },
    mindBin: condition === 'no-memory' ? null : '/worktrees/x/mind',
  };
}

function makeExecutor(
  driver: ReturnType<typeof createFakeSessionDriver>,
  seenJobs: A2UnitJob[] = []
): A2UnitExecutor {
  return async (job: A2UnitJob) => {
    seenJobs.push(job);
    const r = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    return {
      status: 'ok',
      answer: r.finalText,
      memoryCalls: r.memoryCalls,
      toolCalls: r.toolCalls.length,
      model: r.model,
      tokens: r.tokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      steps: r.steps,
      finish: r.finish,
      children: [],
      error: null,
      errorType: null,
      isolationOk: true,
    };
  };
}

const subset = [
  {
    id: 'conv-26#1',
    sampleId: 'conv-26',
    questionIndex: 1,
    category: 1 as const,
    categoryName: 'multi-hop',
    question: 'What color is the hat?',
    answer: 'a red hat',
    evidence: ['D1:1'],
    adversarial: false,
  },
  {
    id: 'conv-26#2',
    sampleId: 'conv-26',
    questionIndex: 2,
    category: 4 as const,
    categoryName: 'single-hop',
    question: 'Where did they travel?',
    answer: 'paris',
    evidence: ['D2:1'],
    adversarial: false,
  },
  {
    id: 'conv-26#3',
    sampleId: 'conv-26',
    questionIndex: 3,
    category: 5 as const,
    categoryName: 'adversarial',
    question: 'What is the secret code?',
    answer: null,
    evidence: [],
    adversarial: true,
  },
];

describe('A2 prompt template', () => {
  test('is identical for every condition and mentions no engine', () => {
    const prompts = (['no-memory', 'mind-v9', 'mind-v10'] as ConditionId[]).map(() =>
      buildA2Prompt('What color is the hat?')
    );
    expect(prompts[0]!).toBe(prompts[1]!);
    expect(prompts[1]!).toBe(prompts[2]!);
    expect(A2_PROMPT_TEMPLATE).not.toMatch(/mind|memory|mcp|engine|v9|v10|no-memory/i);
    expect(buildA2Prompt('Q')).toContain('no information available');
    expect(buildA2Prompt('Q').endsWith('Q')).toBe(true);
  });
});

describe('per-question database copy', () => {
  test('checkpoints and copies a readable database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-dbcopy-'));
    const source = join(dir, 'source.db');
    const db = new Database(source);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = db.prepare('INSERT INTO memories (name) VALUES (?)');
    for (let i = 0; i < 419; i++) insert.run(`D${i}:0`);
    db.close();

    const target = join(dir, 'copy', 'mind.db');
    const result = copyMindDatabaseForQuestion(source, target);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const copy = new Database(target, { readonly: true });
    const count = copy.query('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    copy.close();
    expect(count.n).toBe(419);
  });
});

describe('runA2 dry-run with the fake driver', () => {
  test('produces per-question JSON, scoring, aggregates and budget accounting', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-a2-'));
    const conditions: ConditionId[] = ['no-memory', 'mind-v9', 'mind-v10'];
    for (const c of conditions) mkdirSync(join(runDir, c), { recursive: true });

    // One scripted turn per (condition, question), in iteration order.
    const answers: Record<ConditionId, string[]> = {
      'no-memory': ['some other hat', 'london', 'the secret code is 42'],
      'mind-v9': ['a red hat', 'paris', 'no information available'],
      'mind-v10': ['a red hat', 'paris', 'no information available'],
      'mind-current': ['a red hat', 'paris', 'no information available'],
    };
    const scripts: FakeSessionScript[] = [];
    for (const c of conditions) {
      for (const answer of answers[c]) {
        scripts.push({
          text: answer,
          cost: 0.001,
          toolNames: c === 'no-memory' ? [] : ['mind_memory_query'],
        });
      }
    }
    const driver = createFakeSessionDriver(scripts);
    const budget = new BudgetGuard({ maxCostUsd: 5 });
    const out: string[] = [];
    const seenJobs: A2UnitJob[] = [];

    const run = await runA2(
      {
        runId: 'run-dry',
        runDir,
        conditions,
        subset,
        limits: { steps: 3, timeoutMs: 1000 },
        budget,
        stdout: line => out.push(line),
        stderr: () => undefined,
      },
      {
        profiles: Object.fromEntries(conditions.map(c => [c, profile(c, runDir)])),
        sourceDb: { 'mind-v9': '/fake/v9.db', 'mind-v10': '/fake/v10.db' },
        executor: makeExecutor(driver, seenJobs),
        copyDb: () => ({ sha256: 'deadbeef' }),
      }
    );

    // 9 measurements, 9 prompts through the fake driver. The prompt for the
    // same question is byte-identical across all three conditions.
    expect(driver.prompts).toHaveLength(9);
    for (let q = 0; q < 3; q++) {
      const a = driver.prompts[q]!.prompt;
      const b = driver.prompts[q + 3]!.prompt;
      const c = driver.prompts[q + 6]!.prompt;
      expect(a).toBe(b);
      expect(b).toBe(c);
    }

    const aggregates = Object.fromEntries(run.aggregates.map(a => [a.condition, a]));
    expect(aggregates['no-memory']!.classes.incorrect).toBe(1);
    expect(aggregates['no-memory']!.classes.partial).toBe(1);
    expect(aggregates['no-memory']!.classes.hallucination).toBe(1);
    expect(aggregates['mind-v10']!.classes.correct).toBe(2);
    expect(aggregates['mind-v10']!.classes.correct_abstention).toBe(1);
    expect(aggregates['mind-v10']!.memoryCalls).toBe(3);
    expect(aggregates['no-memory']!.memoryCalls).toBe(0);

    // The A2 worker receives the same expected engine binary that isolation
    // verification proves, exactly like benchmark B.
    expect(
      seenJobs.filter(job => job.condition === 'no-memory').every(job => job.mindBin === null)
    ).toBe(true);
    expect(
      seenJobs
        .filter(job => job.condition !== 'no-memory')
        .every(job => job.mindBin === '/worktrees/x/mind')
    ).toBe(true);

    // Budget accounting: 9 × $0.001.
    expect(budget.spentUsd).toBeCloseTo(0.009, 6);
    expect(run.spentUsd).toBeCloseTo(0.009, 6);

    // Per-condition JSON written and parseable.
    const v10 = JSON.parse(readFileSync(join(runDir, 'results', 'a2-mind-v10.json'), 'utf8'));
    expect(v10).toHaveLength(3);
    expect(v10[2].deterministic.klass).toBe('correct_abstention');

    const aggregatesFile = JSON.parse(
      readFileSync(join(runDir, 'results', 'a2-aggregates.json'), 'utf8')
    );
    expect(aggregatesFile.temperatureRequested).toBe(0);
  });

  test('aborts when accumulated cost crosses the cap', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-a2-cap-'));
    mkdirSync(join(runDir, 'mind-v10'), { recursive: true });
    const executor: A2UnitExecutor = async () => ({
      ...emptyA2Outcome('ok', null),
      answer: 'x',
      costUsd: 0.02,
    });
    const budget = new BudgetGuard({ maxCostUsd: 0.01 });
    await expect(
      runA2(
        {
          runId: 'run-cap',
          runDir,
          conditions: ['mind-v10'],
          subset,
          limits: { steps: 1, timeoutMs: 1000 },
          budget,
          stdout: () => undefined,
          stderr: () => undefined,
        },
        {
          profiles: { 'mind-v10': profile('mind-v10', runDir) },
          sourceDb: { 'mind-v10': '/fake.db' },
          executor,
          copyDb: () => ({ sha256: 'x' }),
        }
      )
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
