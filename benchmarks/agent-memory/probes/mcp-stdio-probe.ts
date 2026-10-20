#!/usr/bin/env bun
/**
 * T1 probe: speak minimal MCP JSON-RPC over stdio to a `mind mcp` server.
 *
 * Verifies (no LLM, no OpenCode):
 *   - stdout carries ONLY JSON-RPC frames (clean stdio framing)
 *   - initialize handshake succeeds
 *   - tools/list returns the expected tool set (names + count)
 *   - tools/call memory_query returns the seeded probe memory
 *
 * Usage:
 *   MIND_BIN=<worktree>/mind MIND_DB_PATH=<db> MIND_DATA_DIR=<dir> \
 *     MIND_SYNC_ROOT=<dir> bun run mcp-stdio-probe.ts
 *
 * Prints a single JSON object with the observed results; exit code 0 on PASS,
 * 1 on FAIL. Raw transcript is written to $MCP_PROBE_OUT (optional).
 */
import { spawn } from 'node:child_process';

const MIND_BIN = process.env.MIND_BIN;
if (!MIND_BIN) {
  console.error('MIND_BIN is required');
  process.exit(2);
}

const out: Record<string, unknown> = {
  mind_bin: MIND_BIN,
  db: process.env.MIND_DB_PATH ?? null,
  protocol: null,
  tools: [] as string[],
  toolCount: 0,
  query: null as unknown,
  nonJsonStdoutLines: [] as string[],
  stderrSample: [] as string[],
  pass: false,
  failures: [] as string[],
};

const child = spawn(MIND_BIN, ['mcp'], {
  env: {
    ...process.env,
    MIND_DB_PATH: process.env.MIND_DB_PATH ?? '',
    MIND_DATA_DIR: process.env.MIND_DATA_DIR ?? '',
    MIND_SYNC_ROOT: process.env.MIND_SYNC_ROOT ?? '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

function send(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(msg + '\n');
  return new Promise(resolve => pending.set(id, resolve));
}
function notify(method: string, params: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

child.stdout.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8');
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      (out.nonJsonStdoutLines as string[]).push(line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (chunk: Buffer) => {
  const s = chunk.toString('utf8');
  (out.stderrSample as string[]).push(...s.split('\n').filter(Boolean).slice(0, 20));
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

try {
  const init: any = await withTimeout(
    send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't1-probe', version: '1.0.0' },
    }),
    15000,
    'initialize'
  );
  out.protocol = init?.result?.protocolVersion ?? null;
  notify('notifications/initialized', {});

  const list: any = await withTimeout(send('tools/list', {}), 15000, 'tools/list');
  const tools = list?.result?.tools ?? [];
  out.tools = tools.map((t: any) => t.name);
  out.toolCount = tools.length;

  const call: any = await withTimeout(
    send('tools/call', {
      name: 'memory_query',
      arguments: { space: 'locomo/probe', search: 'probe', limit: 10 },
    }),
    15000,
    'tools/call memory_query'
  );
  out.query = call?.result ?? call;

  // PASS evaluation
  const fails = out.failures as string[];
  if ((out.nonJsonStdoutLines as string[]).length > 0) fails.push('stdout had non-JSON lines');
  if (!out.protocol) fails.push('initialize returned no protocolVersion');
  if (out.toolCount < 10) fails.push(`unexpectedly few tools: ${out.toolCount}`);
  const names = out.tools as string[];
  for (const required of ['memory_query', 'memory_add', 'space_create', 'system_instructions']) {
    if (!names.includes(required)) fails.push(`missing tool: ${required}`);
  }
  if (!out.query) fails.push('memory_query returned nothing');
  out.pass = fails.length === 0;
} catch (e: any) {
  (out.failures as string[]).push(String(e?.message ?? e));
} finally {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1000).unref?.();
}

console.log(JSON.stringify(out, null, 2));
if (process.env.MCP_PROBE_OUT) {
  await Bun.write(process.env.MCP_PROBE_OUT, JSON.stringify(out, null, 2));
}
process.exit((out.failures as string[]).length === 0 ? 0 : 1);
