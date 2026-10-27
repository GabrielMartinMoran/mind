#!/usr/bin/env bun
// A2 child-process worker: one isolated measurement unit.
//
// The parent (benchmarkA/a2.ts) spawns this once per (condition × question)
// with a job file. The worker:
//   1. applies the job's isolated environment to its own process;
//   2. runs the fail-closed `verifyIsolation` gate (FREE) and writes evidence;
//   3. on contamination, aborts the unit WITHOUT sending a prompt;
//   4. otherwise opens ONE new session through the real SDK driver, runs the
//      prompt to completion under the job limits, captures the transcript and
//      writes `result.json` (the shape `createProcessExecutor` reads).
//
// Any failure is reported as a typed, structured `result.json` and a non-zero
// exit code — the parent never needs to parse stderr.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { A2UnitJob, A2UnitOutcome, A2UnitStatus } from '../benchmarkA/a2';
import { runCommand } from '../exec';
import { ensureIsolationDirs, isolationDirs } from '../isolation/opencode';
import { ContaminationError, verifyIsolation } from '../isolation/verify';
import { stripRedacted } from '../redact';

import {
  DriverAuthError,
  DriverTimeoutError,
  buildDriverEvidence,
  createSdkDriver,
  isRunComplete,
  type DriverErrorWithPartial,
  type DriverEvidence,
  type DriverIdleOutcome,
  type DriverRunResult,
} from './driver';

/** A2 outcome plus the redacted execution evidence A2/B consume. */
type A2OutcomeWithEvidence = A2UnitOutcome & {
  readonly idleOutcome: DriverIdleOutcome | null;
  readonly completion: 'complete' | 'incomplete';
  readonly evidence: DriverEvidence;
};

function writeOutcome(unitDir: string, outcome: A2UnitOutcome): void {
  const path = join(unitDir, 'result.json');
  writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
}

function outcomeFromResult(
  status: A2UnitStatus,
  result: DriverRunResult,
  exactDriverError: string | null,
  isolationOk: boolean
): A2OutcomeWithEvidence {
  const idleOutcome = result.idleOutcome ?? null;
  return {
    status,
    answer: result.finalText,
    memoryCalls: result.memoryCalls,
    toolCalls: result.toolCalls.length,
    model: result.model,
    tokens: result.tokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    steps: result.steps,
    finish: result.finish,
    children: result.childSessionIds ?? [],
    error: exactDriverError,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    idleOutcome,
    completion: isRunComplete({ idleOutcome }) ? 'complete' : 'incomplete',
    evidence:
      result.evidence ??
      buildDriverEvidence({
        sessionId: result.sessionId,
        messages: null,
        childSessionIds: null,
        idleOutcome,
        reason: 'driver returned no evidence',
      }),
  };
}

function emptyOutcome(
  status: A2UnitStatus,
  error: string | null,
  isolationOk = true
): A2OutcomeWithEvidence {
  return {
    status,
    answer: '',
    memoryCalls: 0,
    toolCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: null,
    children: [],
    error,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    idleOutcome: null,
    completion: 'incomplete',
    evidence: buildDriverEvidence({
      sessionId: '',
      messages: null,
      childSessionIds: null,
      idleOutcome: null,
      reason: error ?? 'no session evidence',
    }),
  };
}

async function main(): Promise<number> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.stderr.write('worker: missing job file argument\n');
    return 2;
  }
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as A2UnitJob;
  mkdirSync(job.workspaceDir, { recursive: true });
  mkdirSync(job.unitDir, { recursive: true });

  // The parent spawns this worker with the isolated environment (including the
  // provider credential) already injected. `job.json` on disk only carries the
  // NON-secret subset (redacted), so apply only real values and never let a
  // redaction placeholder clobber an injected secret.
  const runtimeEnv = stripRedacted(job.env);
  for (const [key, value] of Object.entries(runtimeEnv)) process.env[key] = value;

  // 1. Fail-closed isolation gate (FREE) — no prompt until it passes.
  const dir = isolationDirs(job.conditionDir);
  // Unit-owned databases live under the unit directory while HOME/XDG stay in
  // the shared condition tree, so the narrowest root containing every resolved
  // path is the run directory. Legacy jobs without a root keep the strict
  // condition directory.
  const verifyDir = job.isolationRootDir ? { ...dir, conditionDir: job.isolationRootDir } : dir;
  ensureIsolationDirs(dir);
  try {
    await verifyIsolation({
      condition: job.condition,
      dir: verifyDir,
      env: runtimeEnv,
      runner: runCommand,
      evidenceDir: job.evidenceDir,
      mindBin: job.mindBin,
    });
  } catch (error) {
    if (error instanceof ContaminationError) {
      writeOutcome(job.unitDir, emptyOutcome('contaminated', error.message, false));
      return 1;
    }
    writeOutcome(job.unitDir, emptyOutcome('error', `isolation verify failed: ${String(error)}`));
    return 1;
  }

  // 2. One new session, same prompt, run to completion under limits.
  const driver = createSdkDriver();
  try {
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    writeOutcome(job.unitDir, outcomeFromResult('ok', result, null, true));
    return 0;
  } catch (error) {
    const partial = (error as DriverErrorWithPartial).partial ?? null;
    const status: A2UnitStatus =
      error instanceof DriverAuthError
        ? 'auth'
        : error instanceof DriverTimeoutError
          ? 'timeout'
          : 'error';
    const message = error instanceof Error ? error.message : String(error);
    if (partial) {
      writeOutcome(job.unitDir, outcomeFromResult(status, partial, message, true));
    } else {
      writeOutcome(job.unitDir, emptyOutcome(status, message));
    }
    return 1;
  } finally {
    await driver.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}

export { main as runWorker };
