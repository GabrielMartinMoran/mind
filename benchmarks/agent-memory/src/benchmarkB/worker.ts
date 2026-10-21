#!/usr/bin/env bun
// Benchmark B child-process worker: one isolated scenario session.
//
// The parent (benchmarkB/runner.ts) spawns this once per session with a job
// file. The worker:
//   1. applies the job's isolated environment to its own process;
//   2. runs the fail-closed `verifyIsolation` gate (FREE) and writes evidence;
//   3. on contamination, aborts the session WITHOUT sending a prompt;
//   4. otherwise opens ONE new session through the real SDK driver, runs the
//      prompt to completion, captures the transcript and the child (sub-agent)
//      sessions, and writes `result.json`.
//
// Any failure is reported as a typed, structured `result.json`; the parent
// never needs to parse stderr.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand } from '../exec';
import { isolationDirs } from '../isolation/opencode';
import { ContaminationError, verifyIsolation } from '../isolation/verify';
import {
  DriverAuthError,
  DriverTimeoutError,
  createSdkDriver,
  summarizeMessages,
  toList,
  type DriverErrorWithPartial,
  type DriverRunResult,
} from '../opencode/driver';
import { stripRedacted } from '../redact';

import type { BSessionJob } from './runner';
import type { BChildResult, BSessionOutcome, BSessionStatus } from './scenario';

function writeOutcome(sessionDir: string, outcome: BSessionOutcome): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'result.json'), `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
}

function summarizeChild(childId: string, raw: unknown): BChildResult {
  const summary = summarizeMessages(toList(raw), { sessionId: childId, latencyMs: 0 });
  return {
    sessionId: childId,
    finalText: summary.finalText,
    memoryCalls: summary.memoryCalls,
    toolCalls: summary.toolCalls.length,
    tokens: summary.tokens,
    costUsd: summary.costUsd,
    latencyMs: summary.latencyMs,
    steps: summary.steps,
    finish: summary.finish,
    error: summary.error ? summary.error.type : null,
  };
}

async function captureChildren(
  driver: ReturnType<typeof createSdkDriver>,
  sessionId: string
): Promise<BChildResult[]> {
  let ids: readonly string[] = [];
  try {
    ids = await driver.children(sessionId);
  } catch {
    ids = [];
  }
  const children: BChildResult[] = [];
  for (const childId of ids) {
    try {
      children.push(summarizeChild(childId, await driver.rawMessages(childId)));
    } catch {
      children.push({
        sessionId: childId,
        finalText: '',
        memoryCalls: 0,
        toolCalls: 0,
        tokens: null,
        costUsd: 0,
        latencyMs: 0,
        steps: 0,
        finish: null,
        error: 'child transcript unavailable',
      });
    }
  }
  return children;
}

function outcomeFromResult(
  status: BSessionStatus,
  result: DriverRunResult,
  exactDriverError: string | null,
  isolationOk: boolean,
  children: readonly BChildResult[],
  rawMessages: unknown
): BSessionOutcome {
  return {
    status,
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
    error: exactDriverError,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    children,
    rawMessages,
  };
}

function emptyOutcome(
  status: BSessionStatus,
  error: string | null,
  isolationOk = true
): BSessionOutcome {
  return {
    status,
    sessionId: '',
    finalText: '',
    toolCalls: [],
    memoryCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: null,
    error,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    children: [],
    rawMessages: { data: [] },
  };
}

/** Minimal driver surface needed to recover a failed turn's transcript. */
export interface RawMessagesSource {
  rawMessages(sessionId: string): Promise<unknown>;
}

/**
 * Build the outcome for a failed session. When the driver preserved a partial
 * transcript (auth/timeout/error mid-turn) the raw messages are re-read and kept
 * so a failed session still carries evidence — never a hardcoded empty stub.
 */
export async function buildErrorOutcome(
  error: unknown,
  driver: RawMessagesSource
): Promise<BSessionOutcome> {
  const partial = (error as DriverErrorWithPartial).partial ?? null;
  const status: BSessionStatus =
    error instanceof DriverAuthError
      ? 'auth'
      : error instanceof DriverTimeoutError
        ? 'timeout'
        : 'error';
  const message = error instanceof Error ? error.message : String(error);
  if (!partial) return emptyOutcome(status, message);

  let raw: unknown = { data: [] };
  try {
    if (partial.sessionId) raw = await driver.rawMessages(partial.sessionId);
  } catch {
    raw = { data: [] };
  }
  return outcomeFromResult(status, partial, message, true, [], raw);
}

async function main(): Promise<number> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.stderr.write('worker: missing job file argument\n');
    return 2;
  }
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as BSessionJob;
  mkdirSync(job.workspaceDir, { recursive: true });
  mkdirSync(job.sessionDir, { recursive: true });

  // The parent injects the isolated environment (including any credential) into
  // this process; `job.json` carries only the redacted subset, so apply just the
  // real values and never clobber an injected secret with a placeholder.
  const runtimeEnv = stripRedacted(job.env);
  for (const [key, value] of Object.entries(runtimeEnv)) process.env[key] = value;

  // 1. Fail-closed isolation gate (FREE) — no prompt until it passes.
  const dir = isolationDirs(job.conditionDir);
  try {
    await verifyIsolation({
      condition: job.condition,
      dir,
      env: runtimeEnv,
      runner: runCommand,
      evidenceDir: job.evidenceDir,
      mindBin: job.mindBin,
    });
  } catch (error) {
    if (error instanceof ContaminationError) {
      writeOutcome(job.sessionDir, emptyOutcome('contaminated', error.message, false));
      return 1;
    }
    writeOutcome(
      job.sessionDir,
      emptyOutcome('error', `isolation verify failed: ${String(error)}`)
    );
    return 1;
  }

  // 2. One new session, run to completion under limits; capture sub-sessions.
  const driver = createSdkDriver();
  try {
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    const children = await captureChildren(driver, result.sessionId);
    let raw: unknown = { data: [] };
    try {
      raw = await driver.rawMessages(result.sessionId);
    } catch {
      raw = { data: [] };
    }
    writeOutcome(job.sessionDir, outcomeFromResult('ok', result, null, true, children, raw));
    return 0;
  } catch (error) {
    writeOutcome(job.sessionDir, await buildErrorOutcome(error, driver));
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
