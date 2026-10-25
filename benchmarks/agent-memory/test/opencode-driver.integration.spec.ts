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
  hostCreateOptions,
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

// ── explicit per-unit database persistence (no model) ────────────────────────
//
// The embedded SDK ignores `OPENCODE_DB` and defaults to `:memory:`. These free
// tests prove the driver's explicit `database.path` is what makes a unit's
// session/messages visible to a fresh host after the owner closes. No prompt,
// provider call, or model request is made.

interface TestHost {
  sessions: {
    create(input: unknown): Promise<Record<string, unknown> & { id: string }>;
    get(input: { sessionID: string }): Promise<Record<string, unknown> & { id: string }>;
    import(input: unknown): Promise<{ id: string }>;
  };
  message: {
    list(input: { sessionID: string }): Promise<{ data?: unknown[] }>;
  };
  close(): Promise<void>;
}

async function createHost(options: unknown): Promise<TestHost> {
  const sdk = (await import('@opencode/sdk')) as unknown as {
    OpenCode: { create: (options?: unknown) => Promise<TestHost> };
  };
  return sdk.OpenCode.create(options);
}

function applyIsolationEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe.skipIf(!enabled)('embedded SDK unit database (integration)', () => {
  test('explicit database.path persists a session and imported message across hosts', async () => {
    const conditionDir = mkdtempSync(join(tmpdir(), 'bench-driver-db-'));
    try {
      const dir = isolationDirs(conditionDir);
      for (const d of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
        mkdirSync(d, { recursive: true });
      }
      const env = {
        ...process.env,
        ...buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null }),
      };
      applyIsolationEnv(env);
      const options = hostCreateOptions(env, dir.opencodeDb);
      expect(options?.database?.path).toBe(dir.opencodeDb);

      const hostA = await createHost(options);
      const session = await hostA.sessions.create({
        location: { directory: dir.workspace },
        model: { id: MODEL.id, providerID: MODEL.providerID },
      });
      await hostA.close();

      const hostB = await createHost(options);
      try {
        const sessionInfo = await hostB.sessions.get({ sessionID: session.id });
        expect(sessionInfo.id).toBe(session.id);

        const importedId = `ses_imported_${session.id.slice(-8)}`;
        const imported = await hostB.sessions.import({
          info: { ...sessionInfo, id: importedId },
          messages: [
            {
              id: `msg_imported_${session.id.slice(-8)}`,
              time: { created: Date.now() },
              type: 'user',
              text: 'imported redacted evidence',
              files: [],
            },
          ],
        });
        const messages = await hostB.message.list({ sessionID: imported.id });
        const userTexts = (messages.data ?? [])
          .map(entry => entry as Record<string, unknown>)
          .filter(entry => entry.type === 'user')
          .map(entry => entry.text);
        expect(userTexts).toContain('imported redacted evidence');
      } finally {
        await hostB.close();
      }
    } finally {
      rmSync(conditionDir, { recursive: true, force: true });
    }
  }, 120_000);

  test('env-only OPENCODE_DB does not persist a session (defaults to :memory:)', async () => {
    const conditionDir = mkdtempSync(join(tmpdir(), 'bench-driver-envdb-'));
    try {
      const dir = isolationDirs(conditionDir);
      for (const d of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
        mkdirSync(d, { recursive: true });
      }
      const env = {
        ...process.env,
        ...buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null }),
      };
      applyIsolationEnv(env);
      expect(env.OPENCODE_DB).toBe(dir.opencodeDb);
      // Deliberately omit `database`: the raw SDK ignores OPENCODE_DB.
      const envOnlyOptions = { config: hostCreateOptions(env)?.config };

      const hostA = await createHost(envOnlyOptions);
      const session = await hostA.sessions.create({
        location: { directory: dir.workspace },
        model: { id: MODEL.id, providerID: MODEL.providerID },
      });
      await hostA.close();

      const hostB = await createHost(envOnlyOptions);
      try {
        await expect(hostB.sessions.get({ sessionID: session.id })).rejects.toBeDefined();
      } finally {
        await hostB.close();
      }
    } finally {
      rmSync(conditionDir, { recursive: true, force: true });
    }
  }, 120_000);
});
