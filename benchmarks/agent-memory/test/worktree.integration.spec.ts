// Integration tests for the pinned worktree manager.
//
// Gated behind BENCH_INTEGRATION=1 because they shell out to git/bun and reuse
// the worktrees prepared by the T1 probes. They must be idempotent and fast
// when the worktrees already exist.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { PINNED_VERSIONS, type PinnedEngineVersion } from '../src/config';
import { ensureWorktree, probeSchema, worktreePath } from '../src/mind/worktree';

const enabled = process.env.BENCH_INTEGRATION === '1';
const repoRoot = resolve(import.meta.dir, '../../..');
const workRoot = join(repoRoot, 'benchmarks/agent-memory/.work');
const VERSIONS: readonly PinnedEngineVersion[] = ['v9', 'v10'];

describe.skipIf(!enabled)('worktree manager (integration)', () => {
  test('ensures both pinned worktrees idempotently at their pinned SHAs', async () => {
    for (const version of VERSIONS) {
      const first = await ensureWorktree({ repoRoot, workRoot, version });
      expect(first.sha.startsWith(PINNED_VERSIONS[version].ref)).toBe(true);

      const second = await ensureWorktree({ repoRoot, workRoot, version });
      expect(second.created).toBe(false);
      expect(second.sha).toBe(first.sha);
    }
  }, 600_000);

  test('pinned engines report their real schema versions', async () => {
    for (const version of VERSIONS) {
      const dir = mkdtempSync(join(tmpdir(), `bench-schema-${version}-`));
      const info = await probeSchema({
        worktreePath: worktreePath(workRoot, version),
        dataDir: dir,
        dbPath: join(dir, 'mind.db'),
      });
      expect(info.schemaVersion).toBe(PINNED_VERSIONS[version].schemaVersion);
      expect(info.hasTrigram).toBe(version === 'v10');
    }
  }, 600_000);
});
