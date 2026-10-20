import { describe, expect, test } from 'bun:test';

import { MindCli, MindCliError, buildMindEnv, type MindPaths } from '../src/mind/cli';
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

  test('enables RAG only when explicitly requested', () => {
    expect(buildMindEnv(paths, {}, true).MIND_RAG).toBe('true');
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
});
