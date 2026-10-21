// Command-level tests for the free LoCoMo A1 preparation phase. They never
// start a real Mind server or worktree: the dataset fetch is injected to halt
// right after the ensure-worktrees stage, and the command runner is a fake, so
// the only observable side effect is which preparation commands were invoked.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { DEFAULT_CONDITIONS } from '../src/config';
import { runLocomoCommand } from '../src/locomo/command';
import { createFakeRunner } from '../src/testing/fakes';

const repoRoot = resolve(import.meta.dir, '../../..');

function tempBenchDirs(): { root: string; runsRoot: string; workRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-locomo-cmd-'));
  return { root, runsRoot: join(root, 'runs'), workRoot: join(root, '.work') };
}

function haltAfterPreparation(): never {
  throw new Error('halt-after-preparation');
}

describe('locomo command preparation', () => {
  test('default/current conditions use the checkout and prepare no pinned worktree', async () => {
    const dirs = tempBenchDirs();
    try {
      const { runner, calls } = createFakeRunner();
      const out: string[] = [];
      const err: string[] = [];
      const provenance = {
        branch: 'feat/current',
        headSha: 'abc123def',
        dirty: true,
        packageVersion: '1.6.0',
        schemaVersion: null,
        mindBinary: join(repoRoot, 'mind'),
      };

      const code = await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: DEFAULT_CONDITIONS,
          runId: 'run-current',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
        },
        {
          repoRoot,
          runner,
          stdout: line => out.push(line),
          stderr: line => err.push(line),
          fetchDatasetFn: async () => haltAfterPreparation(),
          provenanceFn: () => provenance,
        }
      );

      expect(code).toBe(1);
      expect(out.join('\n')).toContain('conditions=mind-current');
      expect(err.join('\n')).toContain('halt-after-preparation');
      expect(calls.some(call => call.command === 'git')).toBe(false);
      expect(calls.some(call => call.command === 'bun' && call.args.includes('install'))).toBe(
        false
      );

      const meta = JSON.parse(
        readFileSync(join(dirs.runsRoot, 'run-current', 'meta.json'), 'utf8')
      ) as {
        activeConditions?: string[];
        current?: typeof provenance;
      };
      expect(meta.activeConditions).toEqual(['mind-current']);
      expect(meta.current).toEqual(provenance);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test('an explicit historical condition still prepares its pinned worktree', async () => {
    const dirs = tempBenchDirs();
    try {
      const sha = '36d2f1e'.padEnd(40, '0');
      const { runner, calls } = createFakeRunner(invocation => {
        if (invocation.command === 'git' && invocation.args.includes('rev-parse')) {
          return { stdout: `${sha}\n`, exitCode: 0 };
        }
        return { exitCode: 0 };
      });
      const err: string[] = [];

      const code = await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: ['mind-v9'],
          runId: 'run-v9',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
        },
        {
          repoRoot,
          runner,
          stdout: () => undefined,
          stderr: line => err.push(line),
          fetchDatasetFn: async () => haltAfterPreparation(),
          provenanceFn: () => {
            throw new Error('historical runs must not record current provenance');
          },
        }
      );

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('halt-after-preparation');
      expect(
        calls.some(
          call =>
            call.command === 'git' && call.args.includes('worktree') && call.args.includes('add')
        )
      ).toBe(true);

      const meta = JSON.parse(readFileSync(join(dirs.runsRoot, 'run-v9', 'meta.json'), 'utf8')) as {
        activeConditions?: string[];
        current?: unknown;
        shas: { v9: string | null; v10: string | null };
      };
      expect(meta.activeConditions).toEqual(['mind-v9']);
      expect(meta.current).toBeUndefined();
      expect(meta.shas.v9).toBe(sha);
      expect(meta.shas.v10).toBeNull();
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
