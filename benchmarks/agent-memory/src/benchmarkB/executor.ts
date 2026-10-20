// Process-per-session executor for benchmark B.
//
// Every measured session runs as a CHILD process with its own environment and
// the unit's shared isolated directories, exactly like the T4 A2 executor. The
// parent only aggregates the JSON the child reports.
//
// The command runner is injectable, so the executor is unit-testable without
// spawning anything.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandRunner } from '../exec';
import { redactEnv } from '../redact';

import { emptyBSessionOutcome, type BSessionExecutor, type BSessionJob } from './runner';
import type { BSessionOutcome } from './scenario';

export interface ProcessSessionExecutorOptions {
  readonly runner: CommandRunner;
  /** Absolute path to the compiled/executed worker entry. */
  readonly workerPath: string;
  /** Extra wall-clock budget on top of the session timeout for startup. */
  readonly startupGraceMs?: number;
}

export const SESSION_JOB_FILE = 'job.json';

export function createProcessSessionExecutor(
  options: ProcessSessionExecutorOptions
): BSessionExecutor {
  const grace = options.startupGraceMs ?? 30_000;
  return async job => {
    const jobPath = join(job.sessionDir, SESSION_JOB_FILE);
    const resultPath = join(job.sessionDir, 'result.json');
    // Redact credentials in the persisted job; the real env reaches the child
    // only through the spawn environment below.
    writeFileSync(jobPath, `${JSON.stringify({ ...job, env: redactEnv(job.env) })}\n`, 'utf8');

    const result = await options.runner({
      command: 'bun',
      args: ['run', options.workerPath, jobPath],
      cwd: job.workspaceDir,
      env: { ...process.env, ...job.env },
      timeoutMs: job.limits.timeoutMs + grace,
    });

    if (!existsSync(resultPath)) {
      return emptyBSessionOutcome(
        'error',
        `worker produced no result (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      );
    }
    return parseSessionOutcome(readFileSync(resultPath, 'utf8'));
  };
}

export function parseSessionOutcome(text: string): BSessionOutcome {
  try {
    return JSON.parse(text) as BSessionOutcome;
  } catch (error) {
    return emptyBSessionOutcome('error', `invalid worker result JSON: ${String(error)}`);
  }
}

export type { BSessionJob };
