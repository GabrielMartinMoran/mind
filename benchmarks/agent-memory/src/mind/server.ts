// Per-version `mind serve` lifecycle for benchmark A1.
//
// Each condition starts its OWN server from its own pinned worktree, on a free
// high port (never the Mind web default 30303 nor the OpenCode service default
// 49374), under an isolated `MIND_*` environment and cwd, then polls
// `GET /api/search` until it answers before use. On any failure the child is
// killed so no stray server survives. The spawn and fetch functions are
// injectable so the whole lifecycle is unit-testable without real processes.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { buildMindEnv, type MindPaths } from './cli';

/** Ports the benchmark must never grab: Mind web default + OpenCode service. */
export const RESERVED_PORTS: readonly number[] = [30303, 49374];

export class MindServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MindServerError';
  }
}

export interface ServerChild {
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
}

export type ServerSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: Record<string, string | undefined> }
) => ServerChild;

export interface MindServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number | undefined;
  /** Captured stderr so far (includes `MIND_SEARCH_DIAG` timings when enabled). */
  stderr(): string;
  stop(): Promise<void>;
}

export interface StartMindServerOptions {
  /** Absolute path to `<worktree>/mind`. */
  readonly bin: string;
  readonly paths: MindPaths;
  readonly cwd?: string;
  readonly port?: number;
  /** Enable `MIND_SEARCH_DIAG=1` (per-query timing on stderr). */
  readonly searchDiag?: boolean;
  readonly spawnFn?: ServerSpawn;
  readonly fetchFn?: typeof fetch;
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly baseEnv?: Record<string, string | undefined>;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ask the OS for an ephemeral loopback port, retrying if it happens to be one
 * of the reserved ports.
 */
export function findFreePort(
  reserved: readonly number[] = RESERVED_PORTS,
  attempts = 20
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port === 0) {
          reject(new MindServerError('could not allocate a free port'));
          return;
        }
        if (reserved.includes(port) && attempts > 0) {
          findFreePort(reserved, attempts - 1).then(resolve, reject);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function terminate(child: ServerChild, graceMs = 3000): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.on('exit', finish);
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish();
    }, graceMs);
    timer.unref?.();
  });
}

function makeHandle(
  child: ServerChild,
  port: number,
  baseUrl: string,
  readStderr: () => string
): MindServerHandle {
  let stopped = false;
  return {
    port,
    baseUrl,
    pid: child.pid,
    stderr: readStderr,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await terminate(child);
    },
  };
}

export async function startMindServer(options: StartMindServerOptions): Promise<MindServerHandle> {
  const spawnFn = options.spawnFn ?? (spawn as unknown as ServerSpawn);
  const fetchFn = options.fetchFn ?? fetch;
  const port = options.port ?? (await findFreePort());
  const env: Record<string, string | undefined> = {
    ...buildMindEnv(options.paths, options.baseEnv, false),
    MIND_PORT: String(port),
    ...(options.searchDiag ? { MIND_SEARCH_DIAG: '1' } : {}),
  };

  const child = spawnFn(options.bin, ['serve', 'start', '--port', String(port)], {
    cwd: options.cwd,
    env,
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  let exited = false;
  let exitDetail: string | null = null;
  child.on('exit', code => {
    exited = true;
    exitDetail = `server exited early (code ${String(code)})`;
  });
  child.on('error', error => {
    exited = true;
    exitDetail = `server failed to start: ${String(error)}`;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readyUrl = `${baseUrl}/api/search?q=__mind_ready__&limit=1`;
  const deadline = Date.now() + readyTimeoutMs;

  try {
    while (Date.now() < deadline) {
      if (exited) throw new MindServerError(exitDetail ?? 'server exited before becoming ready');
      try {
        const response = await fetchFn(readyUrl);
        if (response.ok) return makeHandle(child, port, baseUrl, () => stderr);
      } catch {
        // Not ready yet (connection refused); keep polling until the deadline.
      }
      await sleep(pollIntervalMs);
    }
    throw new MindServerError(`server did not become ready within ${readyTimeoutMs}ms`);
  } catch (error) {
    await terminate(child);
    throw error;
  }
}
