// Offline tests for the `scenarios` CLI wiring. No network, no LLM: the run is
// exercised with a fake session driver and a fake command runner.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { resolveScenariosCredentialEnv, runScenariosCommand } from '../src/benchmarkB/command';
import type { BSessionExecutor, InitMindDbInput, PrepareUnit } from '../src/benchmarkB/runner';
import type { BChildResult, BSessionOutcome } from '../src/benchmarkB/scenario';
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

function emptyOutcome(scenarioId: string, sessionIndex: number): BSessionOutcome {
  return {
    status: 'ok',
    sessionId: `ses_${scenarioId}_${sessionIndex}`,
    finalText: '',
    toolCalls: [],
    memoryCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: 'stop',
    error: null,
    errorType: null,
    isolationOk: true,
    children: [],
    rawMessages: { data: [] },
  };
}

/** Schema-shaped empty DB so B11's assertion can read it without a real engine. */
async function initEmptyMindDb(input: InitMindDbInput): Promise<void> {
  mkdirSync(input.dirs.mindDataDir, { recursive: true });
  const db = new Database(input.dirs.mindDb);
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, space_id TEXT, name TEXT, content TEXT,
      tier INTEGER, pinned INTEGER, changed_at TEXT
    );
    CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
    CREATE TABLE links (source_id TEXT, target_id TEXT, label TEXT, created_at TEXT);
  `);
  db.close();
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

  test('records active conditions and the actual pinned SHA, not the configured ref', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-shas-'));
    const actualSha = '36d2f1e'.padEnd(40, 'a');
    const runner: CommandRunner = async invocation => ({
      command: invocation.command,
      args: invocation.args,
      stdout:
        invocation.command === 'git' && invocation.args.includes('rev-parse')
          ? `${actualSha}\n`
          : '',
      stderr: '',
      exitCode: 0,
    });

    const code = await runScenariosCommand(
      {
        runId: 'run-shas',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['no-memory', 'mind-v9'],
        scenarios: ['b1'],
        budgetUsd: 5,
      },
      {
        repoRoot: REPO_ROOT,
        runner,
        stdout: () => undefined,
        stderr: () => undefined,
        executor: fakeExecutor(),
        credentialEnv: {},
      }
    );

    expect(code).toBe(0);
    const meta = JSON.parse(readFileSync(join(runDir, 'run-shas', 'meta.json'), 'utf8')) as {
      activeConditions?: string[];
      shas: { v9: string | null; v10: string | null };
    };
    expect(meta.activeConditions).toEqual(['no-memory', 'mind-v9']);
    expect(meta.shas.v9).toBe(actualSha);
    expect(meta.shas.v10).toBeNull();
  });

  test('B11-only with a historical condition prepares no worktree and stays not_run', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-b11-v9-'));
    const commands: string[] = [];
    let prepareCalls = 0;
    const runner: CommandRunner = async invocation => {
      commands.push(invocation.command);
      return {
        command: invocation.command,
        args: invocation.args,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    };

    const code = await runScenariosCommand(
      {
        runId: 'run-b11-v9',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['mind-v9'],
        scenarios: ['b11'],
        budgetUsd: 5,
      },
      {
        repoRoot: REPO_ROOT,
        runner,
        stdout: () => undefined,
        stderr: () => undefined,
        credentialEnv: {},
        prepareUnit: async ({ env }) => {
          prepareCalls += 1;
          return env;
        },
        executor: async job => {
          throw new Error(`B11 should not execute: ${job.condition}`);
        },
      }
    );

    expect(code).toBe(0);
    expect(prepareCalls).toBe(0);
    // No `git worktree add` and no `bun install` for an ineligible condition.
    expect(commands.filter(command => command === 'git' || command === 'bun')).toEqual([]);

    const results = JSON.parse(
      readFileSync(join(runDir, 'run-b11-v9', 'results', 'scenarios-mind-v9.json'), 'utf8')
    ) as { status: string; notRunReason: string | null; sessions: unknown[] }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('not_run');
    expect(results[0]!.notRunReason).toContain('skill-first');
    expect(results[0]!.sessions).toHaveLength(0);
  });

  test('B11 with mind-current prepares the shared setup once and runs both sessions', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-b11-current-'));
    const commands: string[] = [];
    let prepareCalls = 0;
    const prepareUnit: PrepareUnit = async ({ env }) => {
      prepareCalls += 1;
      return { ...env, PREPARED: 'yes' };
    };
    const runner: CommandRunner = async invocation => {
      commands.push(invocation.command);
      return {
        command: invocation.command,
        args: invocation.args,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    };
    let sessions = 0;

    const code = await runScenariosCommand(
      {
        runId: 'run-b11-current',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['mind-current'],
        scenarios: ['b11'],
        budgetUsd: 5,
      },
      {
        repoRoot: REPO_ROOT,
        runner,
        stdout: () => undefined,
        stderr: () => undefined,
        credentialEnv: {},
        prepareUnit,
        executor: async job => {
          sessions += 1;
          expect(job.env.PREPARED).toBe('yes');
          return emptyOutcome(job.scenarioId, job.sessionIndex);
        },
        initMindDb: initEmptyMindDb,
      }
    );

    expect(code).toBe(0);
    expect(prepareCalls).toBe(1);
    expect(sessions).toBe(2);
    expect(commands.filter(command => command === 'git' || command === 'bun')).toEqual([]);

    const results = JSON.parse(
      readFileSync(
        join(runDir, 'run-b11-current', 'results', 'scenarios-mind-current.json'),
        'utf8'
      )
    ) as { notRunReason: string | null; sessions: unknown[] }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.notRunReason).toBeNull();
    expect(results[0]!.sessions).toHaveLength(2);
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

describe('run-level RAG override', () => {
  test('a RAG run enables embeddings for every scenario unit, not just B10', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-rag-'));
    const envs: Record<string, string>[] = [];
    const base = fakeExecutor();
    const executor: BSessionExecutor = async job => {
      envs.push(job.env);
      return base(job);
    };

    const code = await runScenariosCommand(
      {
        runId: 'run-rag',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['mind-current'],
        scenarios: ['b1'],
        budgetUsd: 5,
        rag: true,
      },
      {
        repoRoot: REPO_ROOT,
        runner: okRunner(),
        stdout: () => undefined,
        stderr: () => undefined,
        executor,
        credentialEnv: { OPENROUTER_API_KEY: 'test-key' },
        prepareUnit: async ({ env }) => env,
        initMindDb: initEmptyMindDb,
      }
    );

    expect(code).toBe(0);
    // b1 has two sessions; both units share the same run-level environment.
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.MIND_RAG).toBe('true');
      expect(env.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
      expect(env.OPENROUTER_API_KEY).toBe('test-key');
    }
    const meta = JSON.parse(readFileSync(join(runDir, 'run-rag', 'meta.json'), 'utf8')) as {
      rag?: { enabled: boolean; provider: string | null };
    };
    expect(meta.rag).toEqual({ enabled: true, provider: 'openrouter' });
  });

  test('keeps scenario units and the run metadata RAG-off without the flag', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-rag-off-'));
    const envs: Record<string, string>[] = [];
    const base = fakeExecutor();
    const executor: BSessionExecutor = async job => {
      envs.push(job.env);
      return base(job);
    };

    const code = await runScenariosCommand(
      {
        runId: 'run-no-rag',
        runsRoot: runDir,
        workRoot: runDir,
        conditions: ['mind-current'],
        scenarios: ['b1'],
        budgetUsd: 5,
      },
      {
        repoRoot: REPO_ROOT,
        runner: okRunner(),
        stdout: () => undefined,
        stderr: () => undefined,
        executor,
        credentialEnv: {},
        prepareUnit: async ({ env }) => env,
        initMindDb: initEmptyMindDb,
      }
    );

    expect(code).toBe(0);
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.MIND_RAG).toBe('false');
      expect(env.MIND_EMBEDDING_PROVIDER).toBeUndefined();
    }
    const meta = JSON.parse(readFileSync(join(runDir, 'run-no-rag', 'meta.json'), 'utf8')) as {
      rag?: { enabled: boolean; provider: string | null };
    };
    expect(meta.rag).toEqual({ enabled: false, provider: null });
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
