import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, test } from 'bun:test';

import { createSqliteStore } from '../src/store/sqlite-store';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(testDir, '..');
const mindPath = join(projectRoot, 'src', 'mind.ts');

const CALLER_INFO_KEYS = [
  'agent',
  'agentSource',
  'clientName',
  'clientVersion',
  'mcpSession',
  'transport',
];

type CallerInfo = Record<string, unknown>;

async function readMcpCallerInfo(dbPath: string): Promise<CallerInfo> {
  const store = createSqliteStore(dbPath);
  try {
    const { logs } = store.queryLogs({ source: 'mcp', operation: 'status', limit: 1 });
    expect(logs).toHaveLength(1);
    return JSON.parse(logs[0]!.caller_info as string) as CallerInfo;
  } finally {
    store.close();
  }
}

function baseChildEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const { MIND_AGENT: _ignored, ...baseEnv } = process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...baseEnv, ...overrides })) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = server.port;
  server.stop(true);
  if (port === undefined) {
    throw new Error('Bun did not allocate a port');
  }
  return port;
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not listening yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`MCP HTTP server did not become healthy at ${url}`);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    await cleanup();
  }
});

function trackTempDir(path: string): void {
  cleanups.push(() => rm(path, { recursive: true, force: true }));
}

describe('MCP agent attribution (stdio)', () => {
  test('MIND_AGENT identifies a stdio client', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-attribution-env-'));
    trackTempDir(tempDir);
    const dbPath = join(tempDir, 'mind.db');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['run', mindPath, 'mcp'],
      env: baseChildEnv({
        MIND_DB_PATH: dbPath,
        MIND_SYNC_ROOT: tempDir,
        MIND_AGENT: 'opencode',
      }),
    });
    const client = new Client({ name: 'mystery-stdio-client', version: '1.0.0' });
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    });

    await client.connect(transport);
    await client.callTool({ name: 'status', arguments: {} });

    const callerInfo = await readMcpCallerInfo(dbPath);
    expect(callerInfo.agent).toBe('opencode');
    expect(callerInfo.agentSource).toBe('env');
    expect(callerInfo.transport).toBe('stdio');
    expect(callerInfo.clientName).toBe('mystery-stdio-client');
  });

  test('initialize clientInfo identifies the agent when MIND_AGENT is not set', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-attribution-client-'));
    trackTempDir(tempDir);
    const dbPath = join(tempDir, 'mind.db');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['run', mindPath, 'mcp'],
      env: baseChildEnv({ MIND_DB_PATH: dbPath, MIND_SYNC_ROOT: tempDir }),
    });
    const client = new Client({ name: 'claude-code', version: '2.0.0' });
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    });

    await client.connect(transport);
    await client.callTool({ name: 'status', arguments: {} });

    const callerInfo = await readMcpCallerInfo(dbPath);
    expect(callerInfo.agent).toBe('claude-code');
    expect(callerInfo.agentSource).toBe('client');
    expect(callerInfo.clientVersion).toBe('2.0.0');
    expect(callerInfo.transport).toBe('stdio');
  });
});

describe('MCP agent attribution (HTTP)', () => {
  test('HTTP clientInfo takes precedence over an inherited environment', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-attribution-http-'));
    trackTempDir(tempDir);
    const dbPath = join(tempDir, 'mind.db');
    const port = await getFreePort();

    const proc = Bun.spawn({
      cmd: [process.execPath, 'run', mindPath, 'mcp', 'start', '--http', '--port', String(port)],
      env: baseChildEnv({
        MIND_DB_PATH: dbPath,
        MIND_SYNC_ROOT: tempDir,
        MIND_AGENT: 'codex',
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    cleanups.push(async () => {
      proc.kill();
      await proc.exited.catch(() => {});
    });

    await waitForHealth(`http://127.0.0.1:${port}/health`);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'opencode', version: '9.9.9' });
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    });

    await client.connect(transport);
    await client.callTool({ name: 'status', arguments: {} });

    const callerInfo = await readMcpCallerInfo(dbPath);
    expect(callerInfo.agent).toBe('opencode');
    expect(callerInfo.agentSource).toBe('client');
    expect(callerInfo.clientVersion).toBe('9.9.9');
    expect(callerInfo.transport).toBe('http');
    expect(typeof callerInfo.mcpSession).toBe('string');
  });
});

describe('MCP caller_info payload', () => {
  test('contains only the attribution fields and keeps the mcp source', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-attribution-payload-'));
    trackTempDir(tempDir);
    const dbPath = join(tempDir, 'mind.db');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['run', mindPath, 'mcp'],
      env: baseChildEnv({
        MIND_DB_PATH: dbPath,
        MIND_SYNC_ROOT: tempDir,
        MIND_AGENT: 'opencode',
      }),
    });
    const client = new Client({ name: 'payload-check-client', version: '1.0.0' });
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    });

    await client.connect(transport);
    await client.callTool({ name: 'status', arguments: {} });

    const store = createSqliteStore(dbPath);
    try {
      const { logs } = store.queryLogs({ source: 'mcp', operation: 'status', limit: 1 });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.source).toBe('mcp');
      expect(logs[0]!.level).toBe('info');
      expect(logs[0]!.duration_ms).toEqual(expect.any(Number));

      const callerInfo = JSON.parse(logs[0]!.caller_info as string) as CallerInfo;
      expect(Object.keys(callerInfo).sort()).toEqual([...CALLER_INFO_KEYS].sort());
    } finally {
      store.close();
    }
  });
});
