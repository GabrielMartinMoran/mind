// Handcrafted benchmark-run fixtures for the aggregation and report tests.
//
// These are OUR OWN numbers (never copied from a real run): small, fully known
// synthetic results so the golden assertions can pin exact metrics and diffs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { A2Class, A2QuestionResult } from '../../src/benchmarkA/judge';
import type { ScenarioConditionResult } from '../../src/benchmarkB/runner';
import type { ConditionId } from '../../src/config';
import type { A1AggregateMetrics, A1Result } from '../../src/locomo/a1';
import type { RunMeta } from '../../src/run';

export function makeMeta(runId = 'run-test-20261018-000000'): RunMeta {
  return {
    runId,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    shas: { v9: '1111111', v10: '2222222' },
    versions: { opencode: null, sdk: null, bun: '1.3.14' },
    model: { providerID: 'openrouter', id: 'deepseek/deepseek-v4.1-flash', variant: 'default' },
    dataset: {
      url: 'https://example.test/locomo.json',
      sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    subset: { seed: 20261018, count: 5, conversation: 'conv-26' },
    limits: { sessionSteps: 30, timeoutMs: 600000, maxCostUsd: null },
    budget: { maxCostUsd: 0, spentUsd: 0 },
    stages: {},
    artifacts: {
      root: '/abs/run',
      results: '/abs/run/results',
      conditions: {
        'no-memory': '/abs/run/no-memory',
        'mind-v9': '/abs/run/mind-v9',
        'mind-v10': '/abs/run/mind-v10',
        'mind-current': '/abs/run/mind-current',
      },
    },
  };
}

export function bucket(overrides: Partial<A1AggregateMetrics> = {}): A1AggregateMetrics {
  return {
    count: 4,
    evidenceCount: 4,
    hitAt5: null,
    hitAt10: null,
    evidenceRecallAt10: null,
    mrr: null,
    precisionAt10: null,
    contextTokensAt5: null,
    contextTokensAt10: null,
    contextTokensAt25: null,
    latencyP50Ms: null,
    ...overrides,
  };
}

/** An A1 result with two category-1 questions (known result counts). */
export function makeA1(overrides: Partial<A1AggregateMetrics> = {}): A1Result {
  const metrics = bucket(overrides);
  return {
    space: 'locomo/conv-26',
    topK: 25,
    questions: [
      {
        id: 'conv-26#1',
        sampleId: 'conv-26',
        questionIndex: 1,
        category: 1,
        categoryName: 'multi-hop',
        adversarial: false,
        question: 'q1',
        answer: 'a1',
        evidence: ['D1:1'],
        evidenceEvaluable: true,
        rankedRefs: ['D1:1'],
        rankedContents: ['c'],
        resultCount: 3,
        latencyMs: 10,
        metrics: {
          hitAt5: true,
          hitAt10: true,
          evidenceRecallAt10: 1,
          mrr: 1,
          precisionAt10: 0.5,
          contextTokensAt5: 1,
          contextTokensAt10: 2,
          contextTokensAt25: 3,
        },
      },
      {
        id: 'conv-26#2',
        sampleId: 'conv-26',
        questionIndex: 2,
        category: 1,
        categoryName: 'multi-hop',
        adversarial: false,
        question: 'q2',
        answer: 'a2',
        evidence: ['D2:2'],
        evidenceEvaluable: true,
        rankedRefs: [],
        rankedContents: [],
        resultCount: 5,
        latencyMs: 30,
        metrics: {
          hitAt5: false,
          hitAt10: false,
          evidenceRecallAt10: 0,
          mrr: 0,
          precisionAt10: 0,
          contextTokensAt5: 0,
          contextTokensAt10: 0,
          contextTokensAt25: 0,
        },
      },
    ],
    aggregates: {
      overallCat1To4: metrics,
      cat5Adversarial: bucket({ count: 1, evidenceCount: 1 }),
      perCategory: { '1': metrics },
    },
  };
}

export function makeA2(
  condition: ConditionId,
  id: string,
  klass: A2Class,
  options: {
    f1?: number | null;
    judgeScore?: number | null;
    memoryCalls?: number;
    latencyMs?: number;
    error?: string | null;
    rep?: number;
  } = {}
): A2QuestionResult {
  return {
    id,
    ...(options.rep !== undefined ? { rep: options.rep } : {}),
    category: 1,
    categoryName: 'multi-hop',
    adversarial: false,
    condition,
    answer: `answer-${condition}`,
    reference: 'ref',
    deterministic: { klass, f1: options.f1 ?? null, abstained: false },
    judge:
      options.judgeScore === undefined || options.judgeScore === null
        ? null
        : { candidate: 1, klass, score: options.judgeScore },
    memoryCalls: options.memoryCalls ?? 0,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.001,
    latencyMs: options.latencyMs ?? 100,
    error: options.error ?? null,
  };
}

export function makeScenario(
  condition: ConditionId,
  scenarioId: string,
  pass: boolean,
  options: {
    childCount?: number;
    childMemoryCalls?: number;
    memoryCalls?: number;
    status?: 'passed' | 'failed' | 'not_run';
    notRunReason?: string;
  } = {}
): ScenarioConditionResult {
  const childCount = options.childCount ?? 0;
  const children = Array.from({ length: childCount }, (_value, index) => ({
    sessionId: `child-${index}`,
    finalText: '',
    memoryCalls: options.childMemoryCalls ?? 0,
    toolCalls: 0,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 1,
    finish: 'stop',
    error: null,
  }));
  return {
    scenarioId,
    title: scenarioId.toUpperCase(),
    condition,
    prompts: ['p1', 'p2'],
    sessions: [
      {
        status: 'ok',
        sessionId: 's0',
        finalText: '',
        toolCalls: [],
        memoryCalls: options.memoryCalls ?? 0,
        model: null,
        tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.002,
        latencyMs: 200,
        steps: 1,
        finish: 'stop',
        error: null,
        errorType: null,
        isolationOk: true,
        children: [],
        rawMessages: { data: [] },
        sessionIndex: 0,
        prompt: 'p1',
      },
    ],
    childResults: children,
    childCount,
    memoryCalls: options.memoryCalls ?? 0,
    costUsd: 0.002,
    assertion: { pass, details: [pass ? 'ok' : 'failed'] },
    mindDb: null,
    error: null,
    status: options.status ?? (pass ? 'passed' : 'failed'),
    notRunReason: options.status === 'not_run' ? (options.notRunReason ?? 'not run') : null,
  };
}

export interface FixtureRun {
  readonly a1?: Partial<Record<ConditionId, A1Result>>;
  readonly a2?: Partial<Record<ConditionId, A2QuestionResult[]>>;
  readonly b?: Partial<Record<ConditionId, ScenarioConditionResult[]>>;
  readonly meta?: RunMeta;
}

/** Write a minimal run directory (`meta.json` + `results/*.json`). */
export function writeFixtureRun(runDir: string, fixture: FixtureRun): void {
  mkdirSync(join(runDir, 'results'), { recursive: true });
  writeFileSync(
    join(runDir, 'meta.json'),
    `${JSON.stringify(fixture.meta ?? makeMeta(), null, 2)}\n`,
    'utf8'
  );
  for (const [condition, a1] of Object.entries(fixture.a1 ?? {})) {
    writeFileSync(
      join(runDir, 'results', `${condition}-a1.json`),
      `${JSON.stringify(a1, null, 2)}\n`,
      'utf8'
    );
  }
  for (const [condition, a2] of Object.entries(fixture.a2 ?? {})) {
    writeFileSync(
      join(runDir, 'results', `a2-${condition}.json`),
      `${JSON.stringify(a2, null, 2)}\n`,
      'utf8'
    );
  }
  for (const [condition, b] of Object.entries(fixture.b ?? {})) {
    writeFileSync(
      join(runDir, 'results', `scenarios-${condition}.json`),
      `${JSON.stringify(b, null, 2)}\n`,
      'utf8'
    );
  }
}
