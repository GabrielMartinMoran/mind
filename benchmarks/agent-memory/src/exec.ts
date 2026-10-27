// Process-execution port shared by the benchmark harness.
//
// The harness shells out to three kinds of external process: `git`/`bun` (to
// prepare pinned worktrees), the per-version `mind` CLI, and `opencode` (to
// verify the isolated environment). All of them go through the single tiny
// `CommandRunner` port below so tests can inject a deterministic fake instead
// of spawning real processes.

import { spawn } from 'node:child_process';

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export class CommandTimeoutError extends Error {
  constructor(
    public readonly invocation: CommandInvocation,
    public readonly timeoutMs: number
  ) {
    super(
      `command timed out after ${timeoutMs}ms: ${invocation.command} ${invocation.args.join(' ')}`
    );
    this.name = 'CommandTimeoutError';
  }
}

// Real runner. Spawns the process, captures stdout/stderr as UTF-8 strings,
// honours an optional timeout, and never throws on a non-zero exit code (the
// caller decides whether an exit code is acceptable).
export const runCommand: CommandRunner = invocation => {
  const { command, args, cwd, env, timeoutMs, stdin } = invocation;

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: env ?? process.env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new CommandTimeoutError(invocation, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ command, args, stdout, stderr, exitCode: code ?? -1 });
    });

    child.stdin.end(stdin);
  });
};
