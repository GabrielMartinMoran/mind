import { describe, expect, test } from 'bun:test';

import { MindCli, MindCliError, buildMindEnv, type MindPaths } from '../src/mind/cli';
import { startMindServer, type ServerChild } from '../src/mind/server';
import { createFakeRunner } from '../src/testing/fakes';

const paths: MindPaths = {
  dataDir: '/runs/run-1/mind-v10',
  dbPath: '/runs/run-1/mind-v10/mind.db',
  syncRoot: '/runs/run-1/mind-v10/syncroot',
};

describe('buildMindEnv', () => {
  test('overrides MIND_* paths and disables RAG by default', () => {
    const env = buildMindEnv(paths, { PATH: '/usr/bin' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.MIND_DATA_DIR).toBe(paths.dataDir);
    expect(env.MIND_DB_PATH).toBe(paths.dbPath);
    expect(env.MIND_SYNC_ROOT).toBe(paths.syncRoot);
    expect(env.MIND_RAG).toBe('false');
  });

  test('enables RAG and selects the OpenRouter provider only when explicitly requested', () => {
    expect(buildMindEnv(paths, {}, true).MIND_RAG).toBe('true');
    expect(buildMindEnv(paths, {}, true).MIND_EMBEDDING_PROVIDER).toBe('openrouter');
    expect(buildMindEnv(paths, {}, false).MIND_EMBEDDING_PROVIDER).toBeUndefined();
  });
});

describe('MindCli', () => {
  test('composes args, env and cwd for the pinned binary', async () => {
    const { runner, calls } = createFakeRunner(() => ({ stdout: 'ok', exitCode: 0 }));
    const cli = new MindCli({
      bin: '/worktrees/v10/mind',
      paths,
      cwd: '/runs/run-1/mind-v10',
      runner,
    });

    const result = await cli.run(['add', 'locomo/probe', 'D1:1', 'text', '--tier', '3']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(calls[0]!.command).toBe('/worktrees/v10/mind');
    expect(calls[0]!.args).toEqual(['add', 'locomo/probe', 'D1:1', 'text', '--tier', '3']);
    expect(calls[0]!.env!.MIND_DB_PATH).toBe(paths.dbPath);
    expect(calls[0]!.cwd).toBe('/runs/run-1/mind-v10');
  });

  test('exec throws a typed error on a non-zero exit code', async () => {
    const { runner } = createFakeRunner(() => ({ stderr: 'boom', exitCode: 1 }));
    const cli = new MindCli({ bin: '/worktrees/v9/mind', paths, runner });
    await expect(cli.exec(['status'])).rejects.toThrow(MindCliError);
  });

  test('a RAG CLI carries the provider into every invocation', async () => {
    const { runner, calls } = createFakeRunner(() => ({ exitCode: 0 }));
    const cli = new MindCli({ bin: '/w/mind', paths, runner, rag: true });
    await cli.run(['add', 'locomo/conv-26', 'D1:1', 'text', '--tier', '3']);
    expect(calls[0]!.env!.MIND_RAG).toBe('true');
    expect(calls[0]!.env!.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
  });
});

describe('startMindServer RAG wiring', () => {
  test('starts the A1 server with RAG and the provider only when requested', async () => {
    const envs: Record<string, string | undefined>[] = [];
    const spawnFn = (
      _command: string,
      _args: readonly string[],
      options: { env: Record<string, string | undefined> }
    ): ServerChild => {
      envs.push(options.env);
      let exitListener: ((...args: unknown[]) => void) | undefined;
      return {
        pid: 1234,
        kill: () => {
          exitListener?.(0);
          return true;
        },
        on: (event, listener) => {
          if (event === 'exit') exitListener = listener;
        },
        stderr: null,
      };
    };
    const fetchFn = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const handle = await startMindServer({
      bin: '/w/mind',
      paths,
      port: 43123,
      rag: true,
      spawnFn,
      fetchFn,
    });
    await handle.stop();

    expect(envs).toHaveLength(1);
    expect(envs[0]!.MIND_RAG).toBe('true');
    expect(envs[0]!.MIND_EMBEDDING_PROVIDER).toBe('openrouter');

    const offHandle = await startMindServer({
      bin: '/w/mind',
      paths,
      port: 43124,
      spawnFn,
      fetchFn,
    });
    await offHandle.stop();
    expect(envs[1]!.MIND_RAG).toBe('false');
    expect(envs[1]!.MIND_EMBEDDING_PROVIDER).toBeUndefined();
  });
});
