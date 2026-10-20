// Integration test for the fail-closed isolation gate against a REAL isolated
// `opencode` install. Gated behind BENCH_INTEGRATION=1 and skipped when
// `opencode` is not on PATH. No LLM calls, $0.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { runCommand } from '../src/exec';
import { buildOpenCodeEnv, isolationDirs } from '../src/isolation/opencode';
import { verifyIsolation } from '../src/isolation/verify';

const enabled = process.env.BENCH_INTEGRATION === '1' && Boolean(Bun.which('opencode'));

describe.skipIf(!enabled)('verifyIsolation (integration)', () => {
  test('passes against a real isolated no-memory opencode and saves evidence', async () => {
    const conditionDir = mkdtempSync(join(tmpdir(), 'bench-verify-int-'));
    try {
      const dir = isolationDirs(conditionDir);
      for (const d of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
        mkdirSync(d, { recursive: true });
      }
      const env = buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null });
      const evidenceDir = join(conditionDir, 'evidence');

      const report = await verifyIsolation({
        condition: 'no-memory',
        dir,
        env,
        runner: runCommand,
        evidenceDir,
      });

      expect(report.ok).toBe(true);
      expect(report.condition).toBe('no-memory');
      expect(existsSync(join(evidenceDir, 'summary.txt'))).toBe(true);
      // Every check must have run green; the isolated service port must not
      // have leaked the user's shared service. The number is pinned so the
      // "8/8 green" claim stays honest even if a check is dropped later.
      expect(report.checks).toHaveLength(8);
      expect(report.checks.every(check => check.ok)).toBe(true);
    } finally {
      rmSync(conditionDir, { recursive: true, force: true });
    }
  }, 180_000);
});
