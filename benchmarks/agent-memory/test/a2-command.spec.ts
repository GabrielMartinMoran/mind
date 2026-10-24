// Offline tests for the paid A2 command wiring. No network, no real driver:
// the judge stage and the judge-only path are exercised with fakes.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { emptyA2Outcome, type A2UnitExecutor } from '../src/benchmarkA/a2';
import {
  groupCandidates,
  readStoredResults,
  resolveWorktrees,
  runA2Command,
  runJudgeStage,
  type PrepareCondition,
} from '../src/benchmarkA/command';
import type { A2QuestionResult } from '../src/benchmarkA/judge';
import type { ConditionId } from '../src/config';
import type { SubsetItem } from '../src/locomo/subset';
import { createFakeSessionDriver } from '../src/testing/fakes';

function subsetItem(id: string, question: string, answer: string | null, adversarial: boolean) {
  return {
    id,
    sampleId: 'conv-26',
    questionIndex: 0,
    category: adversarial ? 5 : 1,
    categoryName: adversarial ? 'adversarial' : 'multi-hop',
    question,
    answer,
    evidence: [],
    adversarial,
  } as unknown as SubsetItem;
}

function result(
  id: string,
  condition: ConditionId,
  answer: string,
  adversarial: boolean
): A2QuestionResult {
  return {
    id,
    category: adversarial ? 5 : 1,
    categoryName: adversarial ? 'adversarial' : 'multi-hop',
    adversarial,
    condition,
    answer,
    reference: adversarial ? null : 'ref',
    deterministic: { klass: 'incorrect', f1: null, abstained: false },
    judge: null,
    memoryCalls: 0,
    tokens: null,
    costUsd: 0,
    latencyMs: 1,
    error: null,
  };
}

const subset: SubsetItem[] = [
  subsetItem('q1', 'What color is the hat?', 'red', false),
  subsetItem('q2', 'What is the code?', null, true),
];

const conditions: readonly ConditionId[] = ['mind-v9', 'mind-v10'];

describe('groupCandidates', () => {
  test('groups each condition answer under the matching question', () => {
    const results = [
      result('q1', 'mind-v9', 'red', false),
      result('q1', 'mind-v10', 'a hat', false),
      result('q2', 'mind-v9', 'no information available', true),
      result('q2', 'mind-v10', 'invented', true),
    ];
    const questions = groupCandidates(results, subset);
    expect(questions.map(q => q.id)).toEqual(['q1', 'q2']);
    expect(questions[0]!.candidates.map(c => c.condition)).toEqual(['mind-v9', 'mind-v10']);
    expect(questions[1]!.adversarial).toBe(true);
  });

  test('never sends incomplete or empty answers to the blind judge', () => {
    const incomplete = {
      ...result('q1', 'mind-v9', '', false),
      deterministic: { klass: 'incomplete' as const, f1: null, abstained: false },
    };
    const empty = {
      ...result('q1', 'mind-v10', '   ', false),
      deterministic: { klass: 'empty_answer' as const, f1: null, abstained: false },
    };
    const answered = result('q1', 'no-memory', 'red', false);

    const questions = groupCandidates([incomplete, empty, answered], subset);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.candidates.map(c => c.condition)).toEqual(['no-memory']);

    const onlyUnscored = groupCandidates([incomplete, empty], subset);
    expect(onlyUnscored).toHaveLength(0);
  });
});

describe('runJudgeStage', () => {
  test('maps verdicts back to conditions and aggregates per condition', async () => {
    const driver = createFakeSessionDriver([
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1},{"candidate":2,"class":"partial","score":0.5}]}',
      },
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct_abstention","score":1},{"candidate":2,"class":"hallucination","score":0}]}',
      },
    ]);
    const results = [
      result('q1', 'mind-v9', 'red', false),
      result('q1', 'mind-v10', 'a hat', false),
      result('q2', 'mind-v9', 'no information available', true),
      result('q2', 'mind-v10', 'invented', true),
    ];
    const stage = await runJudgeStage(results, subset, {
      driver,
      workspaceDir: '/tmp/ws',
      limits: { steps: 1, timeoutMs: 1000 },
    });
    expect(stage.promptCount).toBe(2);
    expect(stage.manualQueue).toEqual([]);
    expect(stage.results.every(r => r.judge !== null)).toBe(true);
    // Every judged result now carries a verdict; aggregates are per condition.
    expect(stage.aggregates.map(a => a.condition).sort()).toEqual(['mind-v10', 'mind-v9']);
  });

  test('clears a stale judge verdict from empty and incomplete results', async () => {
    const driver = createFakeSessionDriver([
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}' },
    ]);
    const stale = { candidate: 1, klass: 'correct', score: 1 };
    const incomplete: A2QuestionResult = {
      ...result('q1', 'mind-v9', '', false),
      deterministic: { klass: 'incomplete', f1: null, abstained: false },
      judge: stale,
    };
    const empty: A2QuestionResult = {
      ...result('q1', 'mind-v10', '   ', false),
      deterministic: { klass: 'empty_answer', f1: null, abstained: false },
      judge: stale,
    };
    const answered = result('q1', 'no-memory', 'red', false);

    const stage = await runJudgeStage([incomplete, empty, answered], subset, {
      driver,
      workspaceDir: '/tmp/ws',
      limits: { steps: 1, timeoutMs: 1000 },
    });

    for (const judged of stage.results) {
      if (judged.condition === 'no-memory') expect(judged.judge?.score).toBe(1);
      else expect(judged.judge).toBeNull();
    }
    // A non-judgeable result never enters the answer-quality mean.
    const byCondition = new Map(
      stage.aggregates.map(aggregate => [aggregate.condition, aggregate])
    );
    expect(byCondition.get('mind-v9')!.judgeScoreMean).toBeNull();
    expect(byCondition.get('mind-v10')!.judgeScoreMean).toBeNull();
  });
});

describe('runA2Command --judge-only', () => {
  function setupRun(): { runDir: string; repoRoot: string; runsRoot: string } {
    const root = mkdtempSync(join(tmpdir(), 'bench-a2cmd-'));
    const runsRoot = join(root, 'runs');
    const runDir = join(runsRoot, 'run-x');
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify({
        runId: 'run-x',
        stages: {},
        limits: { sessionSteps: 1, timeoutMs: 1000 },
      })}\n`,
      'utf8'
    );
    writeFileSync(join(runDir, 'subset.json'), `${JSON.stringify({ items: subset })}\n`, 'utf8');
    for (const condition of conditions) {
      writeFileSync(
        join(runDir, 'results', `a2-${condition}.json`),
        `${JSON.stringify([
          result('q1', condition, condition === 'mind-v9' ? 'red' : 'a hat', false),
          result('q2', condition, 'no information available', true),
        ])}\n`,
        'utf8'
      );
    }
    return { runDir, repoRoot: root, runsRoot: 'runs' };
  }

  test('re-judges stored answers, writes results and a passed meta stage', async () => {
    const { runDir, repoRoot, runsRoot } = setupRun();
    const driver = createFakeSessionDriver([
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1},{"candidate":2,"class":"partial","score":0.5}]}',
      },
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct_abstention","score":1},{"candidate":2,"class":"correct_abstention","score":1}]}',
      },
    ]);
    const out: string[] = [];
    let prepared = 0;
    const code = await runA2Command(
      {
        runId: 'run-x',
        runsRoot,
        workRoot: 'work',
        conditions,
        budgetUsd: 5,
        judgeOnly: true,
      },
      {
        repoRoot,
        runner: async inv => ({ ...inv, stdout: '', stderr: '', exitCode: 0 }),
        stdout: line => out.push(line),
        stderr: () => undefined,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        prepareCondition: async ({ profile }) => {
          prepared += 1;
          return profile;
        },
      }
    );
    expect(code).toBe(0);
    expect(prepared).toBe(0);
    expect(out.join('\n')).toContain('judge:');

    const stored = readStoredResults(runDir, conditions);
    expect(stored.every(r => r.judge !== null)).toBe(true);

    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as {
      stages: Record<string, { status: string }>;
    };
    expect(meta.stages['judge:start']!.status).toBe('passed');
  });

  test('fails cleanly when the run directory does not exist', async () => {
    const err: string[] = [];
    const code = await runA2Command(
      {
        runId: 'missing',
        runsRoot: 'runs',
        workRoot: 'work',
        conditions,
        budgetUsd: 5,
        judgeOnly: true,
      },
      {
        repoRoot: mkdtempSync(join(tmpdir(), 'bench-a2cmd-')),
        runner: async inv => ({ ...inv, stdout: '', stderr: '', exitCode: 0 }),
        stdout: () => undefined,
        stderr: line => err.push(line),
      }
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('not found');
  });
});

describe('A2 prepared-database guard', () => {
  function setupPreparedRun(
    conditions: readonly ConditionId[],
    options: { readonly currentDb: boolean }
  ): { repoRoot: string; runsRoot: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-a2-guard-'));
    writeFileSync(join(repoRoot, 'mind'), '#!/bin/sh\n', 'utf8');
    const runDir = join(repoRoot, 'runs', 'run-guard');
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify({
        runId: 'run-guard',
        stages: {},
        limits: { sessionSteps: 1, timeoutMs: 1000 },
        budget: { maxCostUsd: 5, spentUsd: 0 },
      })}\n`,
      'utf8'
    );
    writeFileSync(join(runDir, 'subset.json'), `${JSON.stringify({ items: subset })}\n`, 'utf8');
    if (options.currentDb) {
      mkdirSync(join(runDir, 'mind-current'), { recursive: true });
      writeFileSync(join(runDir, 'mind-current', 'mind.db'), '', 'utf8');
    }
    return { repoRoot, runsRoot: 'runs' };
  }

  function okRunner() {
    return async (invocation: { command: string; args: readonly string[] }) => ({
      command: invocation.command,
      args: invocation.args,
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  }

  test('a requested Mind condition without a prepared DB fails closed before executing', async () => {
    const { repoRoot, runsRoot } = setupPreparedRun(['mind-current'], { currentDb: false });
    const err: string[] = [];
    let executed = 0;
    let prepared = 0;
    const executor: A2UnitExecutor = async () => {
      executed += 1;
      return emptyA2Outcome('ok', null);
    };

    const code = await runA2Command(
      {
        runId: 'run-guard',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-current'],
        budgetUsd: 5,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner(),
        stdout: () => undefined,
        stderr: line => err.push(line),
        executor,
        credentialEnv: {},
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        prepareCondition: async ({ profile }) => {
          prepared += 1;
          return profile;
        },
      }
    );

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('mind-current');
    expect(err.join('\n')).toContain('A1');
    expect(executed).toBe(0);
    expect(prepared).toBe(0);
  });

  test('a prepared current database answers and judges normally', async () => {
    const { repoRoot, runsRoot } = setupPreparedRun(['mind-current'], { currentDb: true });
    const out: string[] = [];
    let executed = 0;
    const executor: A2UnitExecutor = async () => {
      executed += 1;
      return { ...emptyA2Outcome('ok', null), answer: 'red' };
    };
    const driver = createFakeSessionDriver([
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}',
      },
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}',
      },
    ]);

    const code = await runA2Command(
      {
        runId: 'run-guard',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-current'],
        budgetUsd: 5,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner(),
        stdout: line => out.push(line),
        stderr: () => undefined,
        executor,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        credentialEnv: {},
        prepareCondition: async ({ profile }) => profile,
      }
    );

    expect(code).toBe(0);
    expect(executed).toBe(subset.length);
    expect(out.join('\n')).toContain('a2 mind-current');
    expect(readStoredResults(join(repoRoot, 'runs', 'run-guard'), ['mind-current'])).toHaveLength(
      subset.length
    );
  });

  test('no-memory does not require a Mind database', async () => {
    const { repoRoot, runsRoot } = setupPreparedRun(['no-memory'], { currentDb: false });
    let executed = 0;
    let prepared = 0;
    const executor: A2UnitExecutor = async () => {
      executed += 1;
      return emptyA2Outcome('ok', null);
    };
    const driver = createFakeSessionDriver();

    const code = await runA2Command(
      {
        runId: 'run-guard',
        runsRoot,
        workRoot: 'work',
        conditions: ['no-memory'],
        budgetUsd: 5,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner(),
        stdout: () => undefined,
        stderr: () => undefined,
        executor,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        credentialEnv: {},
        prepareCondition: async ({ profile }) => {
          prepared += 1;
          return profile;
        },
      }
    );

    expect(code).toBe(0);
    expect(executed).toBe(subset.length);
    expect(prepared).toBe(0);
  });
});

describe('A2 skill-first preparation', () => {
  const activation = '/isolated/home/.config/opencode/instructions/mind-memory-protocol.md';

  function setupRun(withDb: readonly ConditionId[]): {
    repoRoot: string;
    runsRoot: string;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-a2-prep-'));
    writeFileSync(join(repoRoot, 'mind'), '#!/bin/sh\n', 'utf8');
    const runDir = join(repoRoot, 'runs', 'run-prep');
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify({
        runId: 'run-prep',
        stages: {},
        limits: { sessionSteps: 1, timeoutMs: 1000 },
        budget: { maxCostUsd: 5, spentUsd: 0 },
      })}\n`,
      'utf8'
    );
    writeFileSync(join(runDir, 'subset.json'), `${JSON.stringify({ items: subset })}\n`, 'utf8');
    for (const condition of withDb) {
      mkdirSync(join(runDir, condition), { recursive: true });
      writeFileSync(join(runDir, condition, 'mind.db'), '', 'utf8');
    }
    return { repoRoot, runsRoot: 'runs' };
  }

  const okRunner = async (invocation: { command: string; args: readonly string[] }) => ({
    command: invocation.command,
    args: invocation.args,
    stdout: '',
    stderr: '',
    exitCode: 0,
  });

  function preparingFake(calls: string[]): PrepareCondition {
    return async ({ profile }) => {
      calls.push(profile.id);
      const config = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
      return {
        ...profile,
        env: {
          ...profile.env,
          OPENCODE_CONFIG_CONTENT: `${JSON.stringify(
            { ...config, instructions: [activation] },
            null,
            2
          )}\n`,
        },
      };
    };
  }

  test('prepares a current condition once and every question inherits its env', async () => {
    const { repoRoot, runsRoot } = setupRun(['mind-current']);
    const preparations: string[] = [];
    const jobEnvs: Record<string, string>[] = [];
    const executor: A2UnitExecutor = async job => {
      jobEnvs.push(job.env);
      return { ...emptyA2Outcome('ok', null), answer: 'red' };
    };
    const driver = createFakeSessionDriver([
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}' },
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}' },
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}' },
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}' },
    ]);

    const code = await runA2Command(
      {
        runId: 'run-prep',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-current'],
        budgetUsd: 5,
        reps: 2,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner,
        stdout: () => undefined,
        stderr: () => undefined,
        executor,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        credentialEnv: {},
        prepareCondition: preparingFake(preparations),
      }
    );

    expect(code).toBe(0);
    expect(preparations).toEqual(['mind-current']);
    expect(jobEnvs).toHaveLength(subset.length * 2);
    for (const env of jobEnvs) {
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { instructions?: string[] };
      expect(config.instructions).toEqual([activation]);
    }
  });

  test('fails before any question when preparation throws', async () => {
    const { repoRoot, runsRoot } = setupRun(['mind-current']);
    let executed = 0;
    const executor: A2UnitExecutor = async () => {
      executed += 1;
      return emptyA2Outcome('ok', null);
    };
    const err: string[] = [];

    const code = await runA2Command(
      {
        runId: 'run-prep',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-current'],
        budgetUsd: 5,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner,
        stdout: () => undefined,
        stderr: line => err.push(line),
        executor,
        credentialEnv: {},
        prepareCondition: async () => {
          throw new Error('installer produced no skill');
        },
      }
    );

    expect(code).toBe(1);
    expect(executed).toBe(0);
    expect(err.join('\n')).toContain('installer produced no skill');
  });

  test('historical conditions never prepare', async () => {
    const { repoRoot, runsRoot } = setupRun(['mind-v9', 'mind-v10']);
    let prepared = 0;
    let executed = 0;
    const executor: A2UnitExecutor = async () => {
      executed += 1;
      return emptyA2Outcome('ok', null);
    };
    const driver = createFakeSessionDriver([
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1},{"candidate":2,"class":"correct","score":1}]}',
      },
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct_abstention","score":1},{"candidate":2,"class":"correct_abstention","score":1}]}',
      },
    ]);

    const code = await runA2Command(
      {
        runId: 'run-prep',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-v9', 'mind-v10'],
        budgetUsd: 5,
        judgeOnly: false,
      },
      {
        repoRoot,
        runner: okRunner,
        stdout: () => undefined,
        stderr: () => undefined,
        executor,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
        credentialEnv: {},
        prepareCondition: async ({ profile }) => {
          prepared += 1;
          return profile;
        },
      }
    );

    expect(code).toBe(0);
    expect(prepared).toBe(0);
    expect(executed).toBe(subset.length * 2);
  });
});

describe('A2 mind-current resolution', () => {
  test('fails closed when the local checkout has no mind entry point', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-a2-current-'));
    expect(() => resolveWorktrees(repoRoot, join(repoRoot, '.work'), ['mind-current'])).toThrow(
      'local checkout'
    );
  });

  test('maps mind-current to the local checkout when mind exists', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-a2-current-ok-'));
    writeFileSync(join(repoRoot, 'mind'), '#!/bin/sh\n', 'utf8');
    expect(resolveWorktrees(repoRoot, join(repoRoot, '.work'), ['mind-current'])).toEqual({
      current: repoRoot,
    });
  });
});
