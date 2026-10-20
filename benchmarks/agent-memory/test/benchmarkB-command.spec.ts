// Offline tests for the `scenarios` CLI wiring. No network, no LLM: the run is
// exercised with a fake session driver and a fake command runner.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveScenariosCredentialEnv, runScenariosCommand } from '../src/benchmarkB/command';
import type { BSessionExecutor } from '../src/benchmarkB/runner';
import type { BChildResult } from '../src/benchmarkB/scenario';
import { SCENARIOS } from '../src/benchmarkB/scenarios/registry';
import { dispatch, parseCliArgs } from '../src/cli';
import type { CommandRunner } from '../src/exec';
import { createFakeSessionDriver } from '../src/testing/fakes';

const REPO_ROOT = join(import.meta.dir, '../../..');

function okRunner(): CommandRunner {
  return async invocation => ({
    command: invocation.command,
    args: invocation.args,
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Fake executor over a scripted driver; optionally seeds a b1 solution. */
function fakeExecutor(): BSessionExecutor {
  const driver = createFakeSessionDriver(
    SCENARIOS.flatMap(scenario =>
      scenario.sessions.map((_, index) => ({
        text: `${scenario.id}#${index}`,
        cost: 0.001,
        children: scenario.id === 'b4' && index === 1 ? ['ses_child'] : [],
      }))
    )
  );
  return async job => {
    if (job.scenarioId === 'b1') {
      write(
        join(job.workspaceDir, 'data', 'tasks.json'),
        JSON.stringify({ exportedAt: '2026-10-18T00:00:00.000Z', tasks: [] })
      );
    }
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    const children: BChildResult[] = (await driver.children(result.sessionId)).map(id => ({
      sessionId: id,
      finalText: '',
      memoryCalls: 0,
      toolCalls: 0,
      tokens: null,
      costUsd: 0,
      latencyMs: 0,
      steps: 0,
      finish: null,
      error: null,
    }));
    return {
      status: 'ok',
      sessionId: result.sessionId,
      finalText: result.finalText,
      toolCalls: result.toolCalls,
      memoryCalls: result.memoryCalls,
      model: result.model,
      tokens: result.tokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      steps: result.steps,
      finish: result.finish,
      error: null,
      errorType: null,
      isolationOk: true,
      children,
      rawMessages: { data: [] },
    };
  };
}

describe('scenarios CLI parsing', () => {
  test('parses --scenarios into a list', () => {
    const options = parseCliArgs([
      'scenarios',
      '--scenarios',
      'b1,b4',
      '--conditions',
      'no-memory',
    ]);
    expect(options.command).toBe('scenarios');
    expect(options.scenarios).toEqual(['b1', 'b4']);
    expect(options.conditions).toEqual(['no-memory']);
  });
});

describe('scenarios dispatch gating', () => {
  const deps = {
    runner: okRunner(),
    repoRoot: REPO_ROOT,
    stdout: () => undefined,
    stderr: () => undefined,
  };

  test('refuses to run without --budget', async () => {
    const err: string[] = [];
    const code = await dispatch(parseCliArgs(['scenarios', '--conditions', 'no-memory']), {
      ...deps,
      stderr: line => err.push(line),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('without --budget');
  });

  test('refuses to run without --confirm', async () => {
    const err: string[] = [];
    const code = await dispatch(
      parseCliArgs(['scenarios', '--conditions', 'no-memory', '--budget', '0']),
      { ...deps, stderr: line => err.push(line) }
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('without --confirm');
  });

  test('routes to the injected scenarios runner when budget + confirm are given', async () => {
    let called = 0;
    const code = await dispatch(
      parseCliArgs(['scenarios', '--conditions', 'no-memory', '--budget', '0', '--confirm']),
      {
        ...deps,
        scenariosRunner: async () => {
          called += 1;
          return 0;
        },
      }
    );
    expect(code).toBe(0);
    expect(called).toBe(1);
  });
});

describe('runScenariosCommand dry-run', () => {
  test('runs the default scenarios for no-memory, writes results and passes stages', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-cmd-'));
    const out: string[] = [];
    const code = await runScenariosCommand(
      {
        runId: 'run-dry',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['no-memory'],
        scenarios: [],
        budgetUsd: 5,
      },
      {
        repoRoot: REPO_ROOT,
        runner: okRunner(),
        stdout: line => out.push(line),
        stderr: () => undefined,
        executor: fakeExecutor(),
      }
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('scenarios run run-dry');

    const meta = JSON.parse(readFileSync(join(runDir, 'run-dry', 'meta.json'), 'utf8')) as {
      stages: Record<string, { status: string }>;
    };
    expect(meta.stages['scenarios:b1:no-memory']!.status).toBe('passed');
    expect(meta.stages['scenarios:b4:no-memory']!.status).toBe('passed');
    // B5/B6/B7/B8/B9 need a Mind database and B10 needs RAG + a Mind database;
    // the default registry run marks them not_run (reported as skipped stages)
    // instead of executing sessions.
    expect(meta.stages['scenarios:b5:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b6:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b7:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b9:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b8:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b10:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:b11:no-memory']!.status).toBe('skipped');
    expect(meta.stages['scenarios:start']!.status).toBe('passed');

    const resultsPath = join(runDir, 'run-dry', 'results', 'scenarios-no-memory.json');
    expect(existsSync(resultsPath)).toBe(true);
    const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
      childCount: number;
      status: string;
      sessions: unknown[];
    }[];
    expect(results).toHaveLength(9);
    expect(results.find(r => r.childCount === 1)).toBeDefined();
    expect(results.filter(r => r.status === 'not_run')).toHaveLength(7);
    for (const result of results.filter(r => r.status === 'not_run')) {
      expect(result.sessions).toHaveLength(0);
    }
  });

  test('loads the provider credential from the auth store like A2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b-auth-'));
    const authPath = join(dir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ openrouter: { key: 'or-test-key' } }), 'utf8');

    expect(resolveScenariosCredentialEnv({ authPath })).toEqual({
      OPENROUTER_API_KEY: 'or-test-key',
    });
    // An explicit value (including an empty one) always wins, so dry-runs never
    // read the user's auth store.
    expect(resolveScenariosCredentialEnv({ authPath, credentialEnv: {} })).toEqual({});
    expect(resolveScenariosCredentialEnv({ authPath, credentialEnv: { X: 'y' } })).toEqual({
      X: 'y',
    });
  });

  test('rejects an unknown scenario id', async () => {
    const err: string[] = [];
    const code = await runScenariosCommand(
      {
        runId: null,
        runsRoot: mkdtempSync(join(tmpdir(), 'bench-b-cmd-')),
        workRoot: mkdtempSync(join(tmpdir(), 'bench-b-cmd-')),
        conditions: ['no-memory'],
        scenarios: ['nope'],
        budgetUsd: 0,
      },
      {
        repoRoot: REPO_ROOT,
        runner: okRunner(),
        stdout: () => undefined,
        stderr: line => err.push(line),
      }
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('unknown scenario');
  });
});

describe('Makefile scenarios target', () => {
  test('forwards BUDGET and CONFIRM to the paid command', () => {
    const result = spawnSync(
      'make',
      ['-n', 'bench-agent-memory-scenarios', 'BUDGET=5', 'CONFIRM=1'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--budget 5');
    expect(result.stdout).toContain('--confirm');
  });
});
