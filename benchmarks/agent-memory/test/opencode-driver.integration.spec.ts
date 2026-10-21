// Integration test: ONE real prompt through the SDK driver using the CURRENT
// provider (OpenRouter by default) with an intentionally INVALID credential. It
// must surface a typed `DriverAuthError` classified from the provider's 401
// response — no crash, $0 (a rejected request is never billed). Gated behind
// BENCH_INTEGRATION=1 and requires the `opencode` binary.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { MODEL, credentialEnvVarFor } from '../src/config';
import { buildOpenCodeEnv, isolationDirs } from '../src/isolation/opencode';
import {
  DriverAuthError,
  createSdkDriver,
  isAuthError,
  type DriverErrorWithPartial,
} from '../src/opencode/driver';

const enabled = process.env.BENCH_INTEGRATION === '1' && Boolean(Bun.which('opencode'));
const envVar = credentialEnvVarFor(MODEL);

describe.skipIf(!enabled || !envVar)('real 401 auth classification (integration)', () => {
  test('an invalid key yields a typed DriverAuthError, not a crash', async () => {
    const conditionDir = mkdtempSync(join(tmpdir(), 'bench-driver-int-'));
    try {
      const dir = isolationDirs(conditionDir);
      for (const d of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
        mkdirSync(d, { recursive: true });
      }
      const env = {
        ...process.env,
        ...buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null }),
        // Deliberately invalid: rejected with 401 before any billable inference.
        [envVar!]: 'invalid-test-key-auth-classification',
      };
      const driver = createSdkDriver({ env });
      try {
        let caught: unknown;
        try {
          await driver.runPrompt({
            workspaceDir: dir.workspace,
            prompt: 'Reply with the single word: ping',
            limits: { steps: 1, timeoutMs: 60_000 },
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(DriverAuthError);
        const info = (caught as DriverAuthError).info;
        expect(isAuthError(info)).toBe(true);
        expect(info.status === 401 || info.code === 'api_key_expired').toBe(true);
        expect((caught as DriverErrorWithPartial).partial?.costUsd ?? 0).toBe(0);
      } finally {
        await driver.close().catch(() => undefined);
      }
    } finally {
      rmSync(conditionDir, { recursive: true, force: true });
    }
  }, 120_000);
});
