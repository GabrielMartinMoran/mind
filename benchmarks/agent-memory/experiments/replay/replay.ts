// E-WB replay workbench.
//
// Replays a benchmark run's exact retrieval against a copy of a pinned Mind
// worktree's `mind serve`, using the same HTTP surface the Python membench
// harness used (`GET /api/search?q=&space=&limit=`). The original run DB is
// never touched: it is copied into an isolated scratch dir and the server runs
// under `MIND_*` env with RAG off.
//
// Configurable: which worktree (plain or instrumented), which DB, the output
// path, the retrieval limit, and an optional `MIND_SEARCH_DEBUG` sink.
//
// Usage:
//   bun run replay.ts --worktree <dir> --db <db> --probes <jsonl> --out <json> \
//     [--space locomo/membench] [--limit 10] [--debug-sink <path>] [--rag off]
//
// See `README.md` for the validation workflow.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export const DEFAULT_SPACE = 'locomo/membench';
/** Benchmarks A1/A2 wrote `context_chunks` with this depth (membench `top_k`). */
export const BENCHMARK_TOP_K = 10;
const RESERVED_PORTS = [30303, 49374]; // Mind web default + OpenCode service

export interface Probe {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  readonly context_chunks: number | null;
}

export interface ReplayChunk {
  readonly name: string;
  readonly score: number | null;
  readonly confidence: string | null;
  readonly methods: string[] | null;
  readonly content: string;
}

export interface ProbeReplayResult {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  /** `context_chunks` recorded by the original benchmark run (null if absent). */
  readonly expected_context_chunks: number | null;
  /** Raw `/api/search` array length returned this replay. */
  readonly http_count: number;
  /** Non-blank content chunks (matches the benchmark's `map_search_items`). */
  readonly chunk_count: number;
  readonly latency_ms: number;
  readonly chunks: readonly ReplayChunk[];
}

export interface ReplayOutput {
  readonly worktree: string;
  readonly db_source: string;
  readonly db_scratch: string;
  readonly space: string;
  readonly limit: number;
  readonly rag: 'off' | 'on';
  readonly debug_sink: string | null;
  readonly generated_at: string;
  readonly probe_count: number;
  readonly probes: readonly ProbeReplayResult[];
}

export interface ReplayOptions {
  readonly worktree: string;
  readonly db: string;
  readonly probes: string;
  readonly out: string;
  readonly space?: string;
  readonly limit?: number;
  readonly rag?: 'off' | 'on';
  readonly debugSink?: string;
  readonly scratchDir: string;
  readonly readyTimeoutMs?: number;
}

export function readProbes(path: string): Probe[] {
  const text = readFileSync(path, 'utf8');
  const probes: Probe[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as Record<string, unknown>;
    if (record.kind !== 'probe') continue;
    probes.push({
      probe_id: String(record.probe_id ?? ''),
      question: String(record.question ?? ''),
      category: String(record.category ?? ''),
      adversarial: Boolean(record.adversarial),
      context_chunks: typeof record.context_chunks === 'number' ? record.context_chunks : null,
    });
  }
  return probes;
}

/** Copy the SQLite database plus any WAL/SHM sidecars into `destDir`. */
export function copyDatabase(srcDb: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const destDb = join(destDir, 'mind.db');
  copyFileSync(srcDb, destDb);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${srcDb}${suffix}`)) copyFileSync(`${srcDb}${suffix}`, `${destDb}${suffix}`);
  }
  return destDb;
}

/** Ask the OS for an ephemeral loopback port, avoiding the reserved ones. */
export function findFreePort(reserved: readonly number[] = RESERVED_PORTS): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port === 0) return reject(new Error('could not allocate a free port'));
        if (reserved.includes(port)) {
          findFreePort(reserved).then(resolvePort, reject);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

export interface ServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function terminate(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    child.on('exit', finish);
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish();
    }, graceMs);
    timer.unref?.();
  });
}

export interface StartServerOptions {
  readonly bin: string;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly port: number;
  readonly stderrLog: string;
  readonly readyTimeoutMs?: number;
}

/** Start `mind serve` in its own process group and wait until `/api/search` answers. */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const env: Record<string, string | undefined> = {
    ...options.env,
    MIND_PORT: String(options.port),
  };
  const logFd = Bun.file(options.stderrLog).writer();
  const child = spawn(options.bin, ['serve', 'start', '--port', String(options.port)], {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  child.stderr?.on('data', (chunk: Buffer) => logFd.write(chunk));

  let exited = false;
  let exitDetail = '';
  child.on('exit', code => {
    exited = true;
    exitDetail = `mind serve exited early (code ${String(code)})`;
  });
  child.on('error', error => {
    exited = true;
    exitDetail = `mind serve failed to start: ${String(error)}`;
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error(exitDetail || 'mind serve exited before becoming ready');
      try {
        const response = await fetch(`${baseUrl}/api/search?q=__mind_ready__&limit=1`);
        if (response.ok) {
          await logFd.flush();
          await logFd.end();
          return {
            port: options.port,
            baseUrl,
            stop: () => terminate(child),
          };
        }
      } catch {
        // not ready yet
      }
      await sleep(250);
    }
    throw new Error(`mind serve did not become ready within ${options.readyTimeoutMs ?? 30_000}ms`);
  } catch (error) {
    await terminate(child);
    await logFd.end();
    throw error;
  }
}

/** Map raw `/api/search` items to replay chunks, preserving order (blank content skipped). */
export function mapSearchItems(items: unknown): ReplayChunk[] {
  const chunks: ReplayChunk[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = record.content;
    if (typeof content !== 'string' || !content.trim()) continue;
    chunks.push({
      name: typeof record.name === 'string' ? record.name : '',
      score: typeof record.score === 'number' ? record.score : null,
      confidence: typeof record.confidence === 'string' ? record.confidence : null,
      methods: Array.isArray(record.methods) ? (record.methods as string[]) : null,
      content,
    });
  }
  return chunks;
}

/** Build the isolated `MIND_*` environment for one run. */
export function buildEnv(
  scratchDir: string,
  rag: 'off' | 'on'
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MIND_DB_PATH: join(scratchDir, 'mind.db'),
    MIND_DATA_DIR: scratchDir,
    MIND_SYNC_ROOT: join(scratchDir, 'syncroot'),
    MIND_RAG: rag === 'on' ? 'true' : 'false',
  };
  if (rag === 'off') delete env.MIND_EMBEDDING_PROVIDER;
  return env;
}

/** Run the full replay: copy DB, start server, query every probe, stop server. */
export async function runReplay(options: ReplayOptions): Promise<ReplayOutput> {
  const space = options.space ?? DEFAULT_SPACE;
  const limit = options.limit ?? BENCHMARK_TOP_K;
  const rag = options.rag ?? 'off';
  if (rag === 'on') {
    throw new Error('rag=on replay is not wired here (needs a provider key); E-WB1 uses rag=off');
  }

  const probes = readProbes(options.probes);
  const scratchDir = resolve(options.scratchDir);
  const dbScratch = copyDatabase(options.db, scratchDir);
  const env = buildEnv(scratchDir, rag);
  if (options.debugSink) env.MIND_SEARCH_DEBUG = resolve(options.debugSink);

  const port = await findFreePort();
  const server = await startServer({
    bin: join(resolve(options.worktree), 'mind'),
    cwd: resolve(options.worktree),
    env,
    port,
    stderrLog: join(scratchDir, 'serve.stderr.log'),
    readyTimeoutMs: options.readyTimeoutMs,
  });

  try {
    // Drop the readiness probe's debug line so the dump holds exactly the probes.
    if (options.debugSink && existsSync(options.debugSink)) writeFileSync(options.debugSink, '');

    const results: ProbeReplayResult[] = [];
    for (const probe of probes) {
      const params = new URLSearchParams({ q: probe.question, space, limit: String(limit) });
      const started = performance.now();
      const response = await fetch(`${server.baseUrl}/api/search?${params.toString()}`);
      if (!response.ok)
        throw new Error(`/api/search status ${response.status} for ${probe.probe_id}`);
      const items = (await response.json()) as unknown;
      const latencyMs = performance.now() - started;
      const chunks = mapSearchItems(items);
      results.push({
        probe_id: probe.probe_id,
        question: probe.question,
        category: probe.category,
        adversarial: probe.adversarial,
        expected_context_chunks: probe.context_chunks,
        http_count: Array.isArray(items) ? items.length : 0,
        chunk_count: chunks.length,
        latency_ms: latencyMs,
        chunks,
      });
    }

    const output: ReplayOutput = {
      worktree: resolve(options.worktree),
      db_source: resolve(options.db),
      db_scratch: dbScratch,
      space,
      limit,
      rag,
      debug_sink: options.debugSink ? resolve(options.debugSink) : null,
      generated_at: new Date().toISOString(),
      probe_count: results.length,
      probes: results,
    };
    mkdirSync(resolve(options.out, '..'), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally {
    await server.stop();
  }
}

interface CliArgs {
  worktree: string;
  db: string;
  probes: string;
  out: string;
  space: string;
  limit: number;
  debugSink?: string;
  scratchDir: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const scratchDir =
    flags.get('scratch-dir') ??
    join(import.meta.dir, '..', '..', '.work', 'experiments', 'replay-scratch', 'run');
  return {
    worktree: required('worktree'),
    db: required('db'),
    probes: required('probes'),
    out: required('out'),
    space: flags.get('space') ?? DEFAULT_SPACE,
    limit: Number(flags.get('limit') ?? BENCHMARK_TOP_K),
    debugSink: flags.get('debug-sink'),
    scratchDir,
  };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const output = await runReplay(args);
  process.stdout.write(
    `replay done: ${output.probe_count} probes, limit=${output.limit} → ${resolve(args.out)}\n`
  );
}
