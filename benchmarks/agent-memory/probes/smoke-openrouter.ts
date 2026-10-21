#!/usr/bin/env bun
// T7a paid credential smoke: ONE minimal prompt through the real isolated
// OpenCode SDK driver against the authorized provider (OpenRouter by default).
//
// It reuses the harness isolation recipe and the provider-generic credential
// helper: the key is read at runtime from OpenCode's `auth.json` into this
// process's isolated child env only and is NEVER written to the evidence file.
//
// Usage:
//   bun run benchmarks/agent-memory/probes/smoke-openrouter.ts [--out <path>]
//
// Exit code 0 when the assistant returned non-empty text with the expected
// provider/model; 1 otherwise (including auth failures). Evidence is written to
// `benchmarks/agent-memory/probes/evidence/openrouter-smoke.json` by default.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { MODEL, credentialEnvVarFor } from '../src/config';
import { buildOpenCodeEnv, isolationDirs } from '../src/isolation/opencode';
import { createSdkDriver, type DriverErrorWithPartial } from '../src/opencode/driver';
import { MissingCredentialError, loadCredentialEnv } from '../src/opencode/credentials';

const PROBE_TEXT = 'PROBE-OK';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function sanitize(text: string, home: string): string {
  return text.split(home).join('~');
}

async function main(): Promise<number> {
  const home = homedir();
  const repoRoot = resolve(import.meta.dir, '../../..');
  const conditionDir = join(repoRoot, 'benchmarks/agent-memory/.work/t7a-smoke');
  const outPath = resolve(
    repoRoot,
    argValue('--out') ?? 'benchmarks/agent-memory/probes/evidence/openrouter-smoke.json'
  );

  const dir = isolationDirs(conditionDir);
  for (const d of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
    mkdirSync(d, { recursive: true });
  }

  const envVar = credentialEnvVarFor(MODEL);
  const evidence: Record<string, unknown> = {
    probe: 'openrouter-credential-smoke',
    requestedModel: { providerID: MODEL.providerID, id: MODEL.id, variant: MODEL.variant ?? null },
    credentialEnvVar: envVar,
    authPath: '~/.local/share/opencode/auth.json',
    prompt: `Reply with exactly: ${PROBE_TEXT}`,
    content: null,
    model: null,
    costUsd: null,
    tokens: null,
    steps: null,
    latencyMs: null,
    finish: null,
    error: null,
    pass: false,
  };

  let credentialEnv: Record<string, string>;
  try {
    credentialEnv = loadCredentialEnv(MODEL, {
      authPath: join(home, '.local/share/opencode/auth.json'),
    });
  } catch (error) {
    evidence.error =
      error instanceof MissingCredentialError
        ? `missing credential: ${error.message}`
        : sanitize(String(error), home);
    writeEvidence(outPath, evidence, home);
    return 1;
  }

  const isolatedEnv: Record<string, string> = {
    ...process.env,
    ...buildOpenCodeEnv({ condition: 'no-memory', dir, mindBin: null }),
    ...credentialEnv,
  } as Record<string, string>;

  // Apply the isolated env to this process (the embedded SDK host reads it).
  for (const [key, value] of Object.entries(isolatedEnv)) process.env[key] = value;

  const driver = createSdkDriver();
  try {
    const result = await driver.runPrompt({
      workspaceDir: dir.workspace,
      prompt: `Reply with exactly: ${PROBE_TEXT}`,
      limits: { steps: 4, timeoutMs: 120_000 },
    });
    evidence.content = result.finalText;
    evidence.model = result.model;
    evidence.costUsd = result.costUsd;
    evidence.tokens = result.tokens;
    evidence.steps = result.steps;
    evidence.latencyMs = result.latencyMs;
    evidence.finish = result.finish;
    evidence.pass =
      result.finalText.trim().length > 0 &&
      result.model?.providerID === MODEL.providerID &&
      result.model?.id === MODEL.id;
    writeEvidence(outPath, evidence, home);
    return evidence.pass ? 0 : 1;
  } catch (error) {
    const partial = (error as DriverErrorWithPartial).partial ?? null;
    evidence.error = sanitize(error instanceof Error ? error.message : String(error), home);
    if (partial) {
      evidence.content = partial.finalText;
      evidence.model = partial.model;
      evidence.costUsd = partial.costUsd;
      evidence.tokens = partial.tokens;
      evidence.latencyMs = partial.latencyMs;
    }
    writeEvidence(outPath, evidence, home);
    return 1;
  } finally {
    await driver.close().catch(() => undefined);
  }
}

function writeEvidence(outPath: string, evidence: Record<string, unknown>, home: string): void {
  mkdirSync(join(outPath, '..'), { recursive: true });
  const sanitized = JSON.parse(sanitize(JSON.stringify(evidence, null, 2), home)) as unknown;
  writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  // Never echo the evidence's raw content beyond a short preview.
  process.stdout.write(
    `${JSON.stringify(
      {
        pass: evidence.pass,
        credentialEnvVar: evidence.credentialEnvVar,
        model: evidence.model,
        costUsd: evidence.costUsd,
        tokens: evidence.tokens,
        contentPreview: typeof evidence.content === 'string' ? evidence.content.slice(0, 60) : null,
        error: evidence.error,
        evidencePath: outPath.replace(home, '~'),
      },
      null,
      2
    )}\n`
  );
}

if (import.meta.main) {
  process.exit(await main());
}
