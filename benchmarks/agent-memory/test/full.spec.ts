// `full` orchestration tests — the budget/confirm gate is the only place that
// decides whether a `full` run may spend. `planFullStages` is the pure predicate
// and `runFullCommand` is exercised with fake stage entry points so the gating
// and stage ordering can be asserted without touching a real worktree, dataset
// or paid prompt.

import { describe, expect, test } from 'bun:test';

import {
  planFullStages,
  runFullCommand,
  type FullCommandDeps,
  type FullCommandOptions,
} from '../src/full';
import { createFakeRunner } from '../src/testing/fakes';

type StageOptions = { readonly conditions?: readonly string[] };

interface StageSpy {
  readonly order: string[];
  readonly calls: {
    locomo?: StageOptions;
    a2?: StageOptions;
    scenarios?: StageOptions;
  };
  readonly stages: NonNullable<FullCommandDeps['stages']>;
}

function makeStages(
  exits: {
    locomo?: number;
    a2?: number;
    scenarios?: number;
    report?: number;
  } = {}
): StageSpy {
  const order: string[] = [];
  const calls: StageSpy['calls'] = {};
  const stages = {
    locomo: async (options: StageOptions) => {
      order.push('locomo');
      calls.locomo = options;
      return exits.locomo ?? 0;
    },
    a2: async (options: StageOptions) => {
      order.push('a2');
      calls.a2 = options;
      return exits.a2 ?? 0;
    },
    scenarios: async (options: StageOptions) => {
      order.push('scenarios');
      calls.scenarios = options;
      return exits.scenarios ?? 0;
    },
    report: async () => {
      order.push('report');
      return exits.report ?? 0;
    },
  } as unknown as NonNullable<FullCommandDeps['stages']>;
  return { order, calls, stages };
}

function makeDeps(stages: NonNullable<FullCommandDeps['stages']>): FullCommandDeps & {
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const { runner } = createFakeRunner();
  return {
    repoRoot: '/repo',
    runner,
    stages,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    out,
    err,
  };
}

function makeOptions(overrides: Partial<FullCommandOptions> = {}): FullCommandOptions {
  return {
    runId: 'run-x',
    runsRoot: 'benchmarks/agent-memory/runs',
    workRoot: 'benchmarks/agent-memory/.work',
    conditions: ['mind-current'],
    subset: 'pilot',
    budgetUsd: null,
    confirm: false,
    scenarios: [],
    outPath: 'benchmarks/agent-memory/REPORT.md',
    ...overrides,
  };
}

describe('planFullStages', () => {
  test('no budget → free-only A1 plus the trailing report', () => {
    expect(planFullStages({ budgetUsd: null, confirm: false })).toEqual({
      mode: 'free-only',
      stages: ['locomo', 'report'],
    });
  });

  test('budget without --confirm → refuse, only the free A1 stage runs', () => {
    expect(planFullStages({ budgetUsd: 5, confirm: false })).toEqual({
      mode: 'refuse',
      stages: ['locomo'],
    });
  });

  test('budget + --confirm → paid A2 + scenarios, then the report', () => {
    expect(planFullStages({ budgetUsd: 5, confirm: true })).toEqual({
      mode: 'paid',
      stages: ['locomo', 'a2', 'scenarios', 'report'],
    });
  });

  test('a zero budget is still a budget (never the free-only path)', () => {
    expect(planFullStages({ budgetUsd: 0, confirm: true }).mode).toBe('paid');
    expect(planFullStages({ budgetUsd: 0, confirm: false }).mode).toBe('refuse');
  });
});

describe('runFullCommand gating', () => {
  test('(a) no budget runs the free A1 stage then the report only', async () => {
    const { order, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions(), deps);
    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'report']);
    expect(deps.out.join('\n')).toContain('no --budget');
    expect(deps.err).toEqual([]);
  });

  test('(b) budget without --confirm refuses before any paid stage', async () => {
    const { order, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5 }), deps);
    expect(code).toBe(2);
    expect(order).toEqual(['locomo']);
    expect(deps.err.join('\n')).toContain('without --confirm');
  });

  test('(c) budget + --confirm runs A2, then scenarios, then the report', async () => {
    const { order, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5, confirm: true }), deps);
    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'a2', 'scenarios', 'report']);
  });

  test('refuses when no Mind condition is selected', async () => {
    const { order, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ conditions: ['no-memory'] }), deps);
    expect(code).toBe(2);
    expect(order).toEqual([]);
    expect(deps.err.join('\n')).toContain('at least one Mind condition');
    expect(deps.err.join('\n')).toContain('mind-current');
  });

  test('accepts mind-current as a Mind condition without any historical condition', async () => {
    const { order, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ conditions: ['mind-current'] }), deps);
    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'report']);
    expect(deps.out.join('\n')).toContain('no --budget');
  });

  test('a default paid run passes mind-current to A1, A2 and scenarios', async () => {
    const { order, calls, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5, confirm: true }), deps);

    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'a2', 'scenarios', 'report']);
    expect(calls.locomo?.conditions).toEqual(['mind-current']);
    expect(calls.a2?.conditions).toEqual(['mind-current']);
    expect(calls.scenarios?.conditions).toEqual(['mind-current']);
  });

  test('explicit no-memory,mind-current passes both conditions to A2 and scenarios', async () => {
    const { order, calls, stages } = makeStages();
    const deps = makeDeps(stages);
    const code = await runFullCommand(
      makeOptions({ conditions: ['no-memory', 'mind-current'], budgetUsd: 5, confirm: true }),
      deps
    );

    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'a2', 'scenarios', 'report']);
    // A1 is Mind-only; the paid stages see the merged active-condition set.
    expect(calls.locomo?.conditions).toEqual(['mind-current']);
    expect(calls.a2?.conditions).toEqual(['no-memory', 'mind-current']);
    expect(calls.scenarios?.conditions).toEqual(['no-memory', 'mind-current']);
  });

  test('stops without reporting when the free A1 stage fails', async () => {
    const { order, stages } = makeStages({ locomo: 1 });
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5, confirm: true }), deps);
    expect(code).toBe(1);
    expect(order).toEqual(['locomo']);
    expect(deps.err.join('\n')).toContain('A1 stage failed');
  });

  test('skips scenarios and still reports when the paid A2 stage fails', async () => {
    const { order, stages } = makeStages({ a2: 1 });
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5, confirm: true }), deps);
    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'a2', 'report']);
    expect(deps.err.join('\n')).toContain('A2 stage failed');
  });

  test('still reports when the scenarios stage fails', async () => {
    const { order, stages } = makeStages({ scenarios: 1 });
    const deps = makeDeps(stages);
    const code = await runFullCommand(makeOptions({ budgetUsd: 5, confirm: true }), deps);
    expect(code).toBe(0);
    expect(order).toEqual(['locomo', 'a2', 'scenarios', 'report']);
    expect(deps.err.join('\n')).toContain('scenarios stage failed');
  });
});
