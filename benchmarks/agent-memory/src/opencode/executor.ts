// Process-per-measurement executor for A2.
//
// Every (condition × question) runs as a CHILD process with its own environment
// and directories, exactly like the T1 probe. The parent only aggregates the
// JSON the child reports, so per-question DB copies stay clean and there is no
// env/module caching across units.
//
// The command runner is injectable, so the executor is unit-testable without
// spawning anything.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { A2UnitExecutor, A2UnitOutcome } from '../benchmarkA/a2';
import { emptyA2Outcome } from '../benchmarkA/a2';
import type { CommandRunner } from '../exec';
import { redactEnv } from '../redact';

export interface ProcessExecutorOptions {
  readonly runner: CommandRunner;
  /** Absolute path to the compiled/executed worker entry. */
  readonly workerPath: string;
  /** Extra wall-clock budget on top of the session timeout for startup. */
  readonly startupGraceMs?: number;
}

export const JOB_FILE = 'job.json';
export const RESULT_FILE = 'result.json';

export function createProcessExecutor(options: ProcessExecutorOptions): A2UnitExecutor {
  const grace = options.startupGraceMs ?? 30_000;
  return async job => {
    const jobPath = join(job.unitDir, JOB_FILE);
    const resultPath = join(job.unitDir, RESULT_FILE);
    // Persist the job with credentials redacted: the real env (including the
    // provider key) reaches the child only through the spawn environment below,
    // so `job.json` is a safe, grep-clean artifact.
    writeFileSync(jobPath, `${JSON.stringify({ ...job, env: redactEnv(job.env) })}\n`, 'utf8');

    const result = await options.runner({
      command: 'bun',
      args: ['run', options.workerPath, jobPath],
      cwd: job.workspaceDir,
      env: { ...process.env, ...job.env },
      timeoutMs: job.limits.timeoutMs + grace,
    });

    if (!existsSync(resultPath)) {
      return emptyA2Outcome(
        'error',
        `worker produced no result (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      );
    }
    return parseOutcome(readFileSync(resultPath, 'utf8'));
  };
}

export function parseOutcome(text: string): A2UnitOutcome {
  try {
    return JSON.parse(text) as A2UnitOutcome;
  } catch (error) {
    return emptyA2Outcome('error', `invalid worker result JSON: ${String(error)}`);
  }
}
