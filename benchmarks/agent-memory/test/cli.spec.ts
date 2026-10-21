import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  assertSafeRunRoot,
  assertSafeWorkRoot,
  cleanRuns,
  dispatch,
  parseCliArgs,
  realCleanFs,
  type CleanFs,
  type CliOptions,
  type DispatchDeps,
} from '../src/cli';
import { createFakeRunner } from '../src/testing/fakes';

function deps(exitCode = 0): DispatchDeps & {
  out: string[];
  err: string[];
  calls: import('../src/exec').CommandInvocation[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const { runner, calls } = createFakeRunner(() => ({ exitCode }));
  return {
    runner,
    calls,
    repoRoot: '/repo',
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    out,
    err,
  };
}

describe('parseCliArgs', () => {
  test('defaults to help, standard paths and the current condition', () => {
    const options = parseCliArgs([]);
    expect(options.command).toBe('help');
    expect(options.runsRoot).toBe('benchmarks/agent-memory/runs');
    expect(options.conditions).toEqual(['mind-current']);
    expect(options.budgetUsd).toBeNull();
  });

  test('keeps historical and no-memory conditions available explicitly', () => {
    const historical = parseCliArgs(['locomo', '--conditions', 'mind-v9,mind-v10']);
    expect(historical.conditions).toEqual(['mind-v9', 'mind-v10']);

    const baseline = parseCliArgs(['locomo', '--condition', 'no-memory']);
    expect(baseline.conditions).toEqual(['no-memory']);
  });

  test('parses every supported flag', () => {
    const options = parseCliArgs([
      'full',
      '--runs-root',
      '/tmp/opencode/runs',
      '--budget',
      '5',
      '--condition',
      'mind-v9',
      '--confirm',
      '--all',
    ]);
    expect(options).toEqual({
      command: 'full',
      runsRoot: '/tmp/opencode/runs',
      workRoot: 'benchmarks/agent-memory/.work',
      budgetUsd: 5,
      conditions: ['mind-v9'],
      confirm: true,
      all: true,
      subset: 'pilot',
      runId: null,
      answers: false,
      judgeOnly: false,
      reps: 1,
      scenarios: [],
      outPath: null,
    });
  });

  test('parses locomo-specific flags', () => {
    const options = parseCliArgs([
      'locomo',
      '--subset',
      'full',
      '--conditions',
      'mind-v9,mind-v10',
      '--run-id',
      'run-abc',
    ]);
    expect(options.command).toBe('locomo');
    expect(options.subset).toBe('full');
    expect(options.conditions).toEqual(['mind-v9', 'mind-v10']);
    expect(options.runId).toBe('run-abc');
  });

  test('rejects unknown commands, flags, conditions and subsets', () => {
    expect(() => parseCliArgs(['nope'])).toThrow('unknown command');
    expect(() => parseCliArgs(['probe', '--bogus'])).toThrow('unknown flag');
    expect(() => parseCliArgs(['probe', '--condition', 'mind-v8'])).toThrow('unknown condition');
    expect(() => parseCliArgs(['locomo', '--conditions', 'mind-v8'])).toThrow('unknown condition');
    expect(() => parseCliArgs(['locomo', '--subset', 'huge'])).toThrow('unknown subset');
  });

  test('rejects invalid budget values and missing values', () => {
    expect(() => parseCliArgs(['smoke', '--budget', 'abc'])).toThrow('invalid --budget');
    expect(() => parseCliArgs(['smoke', '--budget'])).toThrow('requires a value');
  });
});

describe('dispatch paid-stage refusal', () => {
  test('refuses paid commands with no budget', async () => {
    const d = deps();
    const options = parseCliArgs(['smoke', '--confirm']);
    expect(await dispatch(options, d)).toBe(2);
    expect(d.err.join('\n')).toContain('without --budget');
  });

  test('refuses paid commands without --confirm even with a budget', async () => {
    const d = deps();
    const options = parseCliArgs(['smoke', '--budget', '0.05']);
    expect(await dispatch(options, d)).toBe(2);
    expect(d.err.join('\n')).toContain('without --confirm');
  });

  test('budgeted + confirmed paid command still reports not implemented', async () => {
    const d = deps();
    const options = parseCliArgs(['smoke', '--budget', '5', '--confirm']);
    expect(await dispatch(options, d)).toBe(3);
    expect(d.err.join('\n')).toContain('not implemented');
  });

  test('locomo is free and never requires --budget', async () => {
    const d = deps();
    const withRunner: DispatchDeps = {
      ...d,
      locomoRunner: async (options: CliOptions, dd: DispatchDeps) => {
        dd.stdout(`ran locomo subset=${options.subset}`);
        return 0;
      },
    };
    const options = parseCliArgs(['locomo', '--subset', 'pilot']);
    expect(await dispatch(options, withRunner)).toBe(0);
    expect(d.out.join('\n')).toContain('ran locomo subset=pilot');
  });

  test('locomo refuses when no runner is wired', async () => {
    const d = deps();
    expect(await dispatch(parseCliArgs(['locomo']), d)).toBe(3);
    expect(d.err.join('\n')).toContain('locomo runner is not wired');
  });

  test('locomo --answers refuses without --budget', async () => {
    const d = deps();
    const options = parseCliArgs(['locomo', '--answers', '--confirm', '--run-id', 'run-x']);
    expect(await dispatch(options, d)).toBe(2);
    expect(d.err.join('\n')).toContain('without --budget');
  });

  test('locomo --judge-only refuses without --budget', async () => {
    const d = deps();
    const options = parseCliArgs(['locomo', '--judge-only', '--run-id', 'run-x']);
    expect(await dispatch(options, d)).toBe(2);
    expect(d.err.join('\n')).toContain('without --budget');
  });

  test('locomo --answers refuses without --confirm even with a budget', async () => {
    const d = deps();
    const options = parseCliArgs(['locomo', '--answers', '--budget', '5', '--run-id', 'run-x']);
    expect(await dispatch(options, d)).toBe(2);
    expect(d.err.join('\n')).toContain('without --confirm');
  });

  test('budgeted + confirmed locomo --answers routes to the a2 runner', async () => {
    const d = deps();
    const withRunner: DispatchDeps = {
      ...d,
      a2Runner: async (options, dd) => {
        dd.stdout(`a2 judgeOnly=${options.judgeOnly} runId=${options.runId}`);
        return 0;
      },
    };
    const options = parseCliArgs([
      'locomo',
      '--answers',
      '--budget',
      '5',
      '--confirm',
      '--run-id',
      'run-x',
    ]);
    expect(await dispatch(options, withRunner)).toBe(0);
    expect(d.out.join('\n')).toContain('a2 judgeOnly=false runId=run-x');
  });

  test('locomo --judge-only routes to the a2 runner with judgeOnly=true', async () => {
    const d = deps();
    const withRunner: DispatchDeps = {
      ...d,
      a2Runner: async (options, dd) => {
        dd.stdout(`a2 judgeOnly=${options.judgeOnly} runId=${options.runId}`);
        return 0;
      },
    };
    const options = parseCliArgs([
      'locomo',
      '--judge-only',
      '--run-id',
      'run-y',
      '--budget',
      '5',
      '--confirm',
    ]);
    expect(await dispatch(options, withRunner)).toBe(0);
    expect(d.out.join('\n')).toContain('a2 judgeOnly=true runId=run-y');
  });
});

describe('dispatch free stages', () => {
  test('help prints usage', async () => {
    const d = deps();
    expect(await dispatch(parseCliArgs([]), d)).toBe(0);
    expect(d.out.join('\n')).toContain('Usage:');
  });

  test('probe forwards to the T1 script and returns its exit code', async () => {
    const d = deps(0);
    expect(await dispatch(parseCliArgs(['probe']), d)).toBe(0);
    expect(d.calls[0]!.command).toBe('bash');
    expect(d.calls[0]!.args[0]!.endsWith('probes/run-t1-probes.sh')).toBe(true);
  });

  test('report requires a run id', async () => {
    const d = deps();
    expect(await dispatch(parseCliArgs(['report']), d)).toBe(2);
    expect(d.err.join('\n')).toContain('requires --run-id');
  });

  test('report routes to the report runner when wired', async () => {
    const d = deps();
    const withRunner: DispatchDeps = {
      ...d,
      reportRunner: async (options, dd) => {
        dd.stdout(`report runId=${options.runId} out=${options.outPath}`);
        return 0;
      },
    };
    const options = parseCliArgs(['report', '--run-id', 'run-x', '--out', 'custom.md']);
    expect(await dispatch(options, withRunner)).toBe(0);
    expect(d.out.join('\n')).toContain('report runId=run-x out=custom.md');
  });

  test('report without a wired runner returns a wiring error', async () => {
    const d = deps();
    expect(await dispatch(parseCliArgs(['report', '--run-id', 'run-x']), d)).toBe(3);
    expect(d.err.join('\n')).toContain('report runner is not wired');
  });

  test('full is free-first and routes to the full runner', async () => {
    const d = deps();
    const withRunner: DispatchDeps = {
      ...d,
      fullRunner: async (options, dd) => {
        dd.stdout(`full budget=${options.budgetUsd}`);
        return 0;
      },
    };
    expect(await dispatch(parseCliArgs(['full']), withRunner)).toBe(0);
    expect(d.out.join('\n')).toContain('full budget=null');
  });

  test('full without a wired runner returns a wiring error', async () => {
    const d = deps();
    expect(await dispatch(parseCliArgs(['full']), d)).toBe(3);
    expect(d.err.join('\n')).toContain('full runner is not wired');
  });
});

describe('clean guard', () => {
  test('refuses a runs root that is not named "runs"', () => {
    expect(() => assertSafeRunRoot('/home/user')).toThrow('basename must be');
    expect(() => cleanRuns({ runsRoot: '/', workRoot: '/tmp/w', all: true })).toThrow();
  });

  test('refuses a work root that is not named ".work" under --all', () => {
    expect(() => assertSafeWorkRoot('/tmp/scratch')).toThrow("basename must be '.work'");
    expect(() =>
      cleanRuns({ runsRoot: '/tmp/opencode/bench/runs', workRoot: '/home/user', all: true })
    ).toThrow("basename must be '.work'");
  });

  test('never touches anything outside the runs and .work roots', () => {
    const calls: string[] = [];
    const fs: CleanFs = {
      listDir: path => (path.endsWith('worktrees') ? ['v9'] : ['run-1', 'dataset']),
      removeDir: path => void calls.push(path),
    };
    cleanRuns(
      { runsRoot: '/tmp/opencode/bench/runs', workRoot: '/tmp/opencode/bench/.work', all: true },
      fs
    );
    expect(
      calls.every(
        c => c.startsWith('/tmp/opencode/bench/runs') || c.startsWith('/tmp/opencode/bench/.work')
      )
    ).toBe(true);
  });

  test('removes run dirs but leaves worktrees unless --all', () => {
    const calls: string[] = [];
    const fs: CleanFs = {
      listDir: path => (path.endsWith('worktrees') ? ['v9', 'v10'] : ['run-1', 'run-2']),
      removeDir: path => void calls.push(path),
    };
    const runsRoot = '/tmp/opencode/bench/runs';
    const result = cleanRuns({ runsRoot, workRoot: '/tmp/opencode/bench/.work', all: false }, fs);
    expect(result.removedRuns.length).toBe(2);
    expect(result.removedWorktrees).toEqual([]);
    expect(result.removedWork).toEqual([]);
    expect(calls.every(c => c.startsWith(runsRoot))).toBe(true);

    const allCalls: string[] = [];
    const fsAll: CleanFs = {
      listDir: path => (path.endsWith('worktrees') ? ['v9', 'v10'] : ['run-1', 'dataset']),
      removeDir: path => void allCalls.push(path),
    };
    const allResult = cleanRuns(
      { runsRoot, workRoot: '/tmp/opencode/bench/.work', all: true },
      fsAll
    );
    expect(allResult.removedWorktrees.length).toBe(2);
    expect(allResult.removedWork).toEqual([
      '/tmp/opencode/bench/.work/run-1',
      '/tmp/opencode/bench/.work/dataset',
    ]);
  });
});

describe('dispatch clean root resolution', () => {
  test('resolves relative runs/work roots against repoRoot, not cwd', async () => {
    const calls: string[] = [];
    const d = {
      ...deps(),
      repoRoot: '/repo',
      cleanFs: {
        listDir: (path: string) =>
          path.endsWith(join('worktrees'))
            ? ['v9']
            : path.endsWith('.work')
              ? ['dataset']
              : ['run-1'],
        removeDir: (path: string) => void calls.push(path),
      } satisfies CleanFs,
    };
    expect(await dispatch(parseCliArgs(['clean', '--all']), d)).toBe(0);
    expect(calls).toEqual([
      join('/repo', 'benchmarks/agent-memory/runs/run-1'),
      join('/repo', 'benchmarks/agent-memory/.work/worktrees/v9'),
      join('/repo', 'benchmarks/agent-memory/.work/dataset'),
    ]);
  });

  test('keeps an absolute runs root unchanged', async () => {
    const calls: string[] = [];
    const d = {
      ...deps(),
      repoRoot: '/repo',
      cleanFs: {
        listDir: () => ['run-1'],
        removeDir: (path: string) => void calls.push(path),
      } satisfies CleanFs,
    };
    expect(
      await dispatch(parseCliArgs(['clean', '--runs-root', '/tmp/opencode/bench/runs']), d)
    ).toBe(0);
    expect(calls).toEqual(['/tmp/opencode/bench/runs/run-1']);
  });
});

describe('realCleanFs', () => {
  test('lists a real directory', () => {
    const options: Pick<CliOptions, 'runsRoot' | 'workRoot' | 'all'> = {
      runsRoot: '/tmp',
      workRoot: '/tmp',
      all: false,
    };
    // `/tmp` is not named "runs", so the guard must block it before any delete.
    expect(() => cleanRuns(options, realCleanFs)).toThrow();
  });
});
