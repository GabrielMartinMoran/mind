import { afterEach, describe, expect, test } from 'bun:test';

import { matchApiRoute } from '../src/api/router';
import { handleRequest } from '../src/api/server';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

async function requestJson(path: string): Promise<any> {
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await matchApiRoute(req, store);
  if (!res) throw new Error('Route not matched');
  return res.json();
}

async function requestThroughServer(path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  return handleRequest(req, store);
}

describe('API Routes — Space Graph', () => {
  test('returns minimal graph payload including T1-T3 memories', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);

    const t1 = await store.addMemory('proj', 'hot', 'h', { tier: 1, tags: ['test'] });
    const t2 = await store.addMemory('proj', 'warm', 'w', { tier: 2, tags: ['test'] });
    const t3 = await store.addMemory('proj', 'cold', 'c', { tier: 3, tags: ['test'] });

    store.link(t1.id, t2.id);
    store.link(t3.id, t1.id);

    const payload = await requestJson('/api/spaces/proj/graph');
    expect(payload.meta.total_nodes).toBe(3);
    expect(payload.nodes).toHaveLength(3);

    const coldNode = payload.nodes.find((node: any) => node.id === t3.id);
    expect(coldNode).toBeTruthy();
    expect(coldNode.tier).toBe(3);

    const firstNodeKeys = Object.keys(payload.nodes[0] ?? {}).sort();
    expect(firstNodeKeys).toEqual(['id', 'linked_by', 'links_to', 'name', 'tier']);
  });

  test('applies guardrail cap and returns truncation metadata', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);

    for (let i = 0; i < 6; i++) {
      await store.addMemory('proj', `m-${i}`, `content-${i}`, { tier: 3, tags: ['test'] });
    }

    const payload = await requestJson('/api/spaces/proj/graph?limit=2');
    expect(payload.meta.requested_limit).toBe(2);
    expect(payload.meta.applied_limit).toBe(2);
    expect(payload.meta.total_nodes).toBe(6);
    expect(payload.meta.returned_nodes).toBe(2);
    expect(payload.meta.truncated).toBe(true);
    expect(payload.nodes).toHaveLength(2);
  });
});

describe('API Routes — Logs', () => {
  test('GET /api/logs does not create get_api_logs entries', async () => {
    store = createTestStore();

    await requestJson('/api/logs');
    await requestJson('/api/logs?limit=10');

    const apiLogReads = store.queryLogs({
      source: 'api',
      operation: 'get_api_logs',
      limit: 20,
      offset: 0,
      order: 'asc',
    });

    expect(apiLogReads.logs).toHaveLength(0);
    expect(apiLogReads.total).toBe(0);
  });

  test('GET /api/logs returns log entries', async () => {
    store = createTestStore();

    // Add some logs
    store.addLog({ source: 'cli', operation: 'test_op1' });
    store.addLog({ source: 'mcp', operation: 'test_op2' });

    const payload = await requestJson('/api/logs');
    expect(payload.logs).toHaveLength(2);
    expect(payload.total).toBe(2);
    expect(payload.limit).toBe(100);
    expect(payload.offset).toBe(0);
  });

  test('GET /api/logs filters by source', async () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'cli_op' });
    store.addLog({ source: 'mcp', operation: 'mcp_op' });
    store.addLog({ source: 'api', operation: 'api_op' });

    const payload = await requestJson('/api/logs?source=cli');
    expect(payload.logs).toHaveLength(1);
    expect(payload.logs[0]!.source).toBe('cli');
  });

  test('GET /api/logs filters by operation', async () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'add' });
    store.addLog({ source: 'cli', operation: 'list' });
    store.addLog({ source: 'cli', operation: 'delete' });

    const payload = await requestJson('/api/logs?operation=add');
    expect(payload.logs).toHaveLength(1);
    expect(payload.logs[0]!.operation).toBe('add');
  });

  test('GET /api/logs supports pagination', async () => {
    store = createTestStore();

    for (let i = 0; i < 15; i++) {
      store.addLog({ source: 'cli', operation: `op_${i}` });
    }

    const page1 = await requestJson('/api/logs?limit=5&offset=0');
    expect(page1.logs).toHaveLength(5);
    expect(page1.total).toBe(15);
    expect(page1.offset).toBe(0);

    const page2 = await requestJson('/api/logs?limit=5&offset=5');
    expect(page2.logs).toHaveLength(5);
    expect(page2.offset).toBe(5);
  });

  test('GET /api/logs supports ordering', async () => {
    store = createTestStore();

    // The router middleware will add logs for each API call,
    // so we add enough logs to ensure our test logs are present
    store.addLog({ source: 'cli', operation: 'first' });
    store.addLog({ source: 'cli', operation: 'second' });
    store.addLog({ source: 'cli', operation: 'third' });

    const desc = await requestJson('/api/logs?order=desc&source=cli');
    const cliLogs = desc.logs.filter((log: any) => log.source === 'cli');
    // Our added logs should be in reverse order (newest first)
    expect(cliLogs[0]!.operation).toBe('third');

    const asc = await requestJson('/api/logs?order=asc&source=cli');
    const ascCliLogs = asc.logs.filter((log: any) => log.source === 'cli');
    expect(ascCliLogs[0]!.operation).toBe('first');
  });

  test('GET /api/logs supports since parameter for polling', async () => {
    store = createTestStore();

    // Add logs with known IDs - add many to ensure our test logs are present
    // The middleware may add logs, so we add enough to find our ones
    store.addLog({ source: 'cli', operation: 'test_log_1' });
    store.addLog({ source: 'cli', operation: 'test_log_2' });
    store.addLog({ source: 'cli', operation: 'test_log_3' });

    // Get all logs to find our test logs
    const allLogs = await requestJson('/api/logs?order=asc&source=cli&limit=50');

    // Find our test logs (the ones with operation starting with 'test_log_')
    const testLogs = allLogs.logs.filter((log: any) => log.operation.startsWith('test_log_'));
    expect(testLogs.length).toBe(3);

    const firstTestLogId = testLogs[0]!.id;

    // Query with since - should return logs with id > since
    const result = await requestJson(
      `/api/logs?since=${firstTestLogId}&order=asc&source=cli&limit=50`
    );

    // Filter to only our test logs
    const filteredTestLogs = result.logs.filter((log: any) =>
      log.operation.startsWith('test_log_')
    );

    // Should return 2 logs (test_log_2 and test_log_3)
    expect(filteredTestLogs.length).toBe(2);
    expect(filteredTestLogs[0]!.operation).toBe('test_log_2');
    expect(filteredTestLogs[1]!.operation).toBe('test_log_3');
  });
});

describe('API Server — Static web root resolution', () => {
  test('GET / returns the SPA shell HTML', async () => {
    store = createTestStore();

    const response = await requestThroughServer('/');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('<div id="app">');
    expect(body).not.toContain('ENOENT');
  });

  test('deep routes fall back to the SPA shell HTML', async () => {
    store = createTestStore();

    const response = await requestThroughServer('/spaces/test?view=list');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('<title>Mind</title>');
  });

  test.each([
    ['/styles/main.css', 'text/css', "@import url('/styles/tokens.css');"],
    ['/assets/logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"'],
    ['/src/app.js', 'application/javascript', "import { api } from './api/client.js';"],
  ])(
    'static asset %s resolves from the repo-local web directory',
    async (pathname, type, snippet) => {
      store = createTestStore();

      const response = await requestThroughServer(pathname);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(body).toContain(snippet);
    }
  );

  test('API routes remain routed before static fallback', async () => {
    store = createTestStore();

    const response = await requestThroughServer('/api/status');
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(payload.total_spaces).toBe(0);
    expect(payload.total_memories).toBe(0);
  });
});

describe('API Routes — Search', () => {
  test('returns fused results with score, confidence and methods (flat array)', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'auth-jwt', 'JWT authentication', { tags: ['test'] });

    const payload = await requestJson('/api/search?q=authentication&space=proj');

    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(1);
    expect(payload[0].name).toBe('auth-jwt');
    expect(payload[0].space_name).toBe('proj');
    expect(payload[0].score).toBeGreaterThan(0);
    expect(payload[0].confidence).toMatch(/^(high|medium|low)$/);
    expect(Array.isArray(payload[0].methods)).toBe(true);
  });

  test('defaults to 25 results and supports limit/offset', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    for (let i = 0; i < 30; i++) {
      await store.addMemory('proj', `m${i}`, 'shared token content', { tags: ['test'] });
    }

    const defaultPage = await requestJson('/api/search?q=token&space=proj');
    expect(defaultPage.length).toBe(25);

    const limited = await requestJson('/api/search?q=token&space=proj&limit=5&offset=3');
    expect(limited.length).toBe(5);

    const all = await requestJson('/api/search?q=token&space=proj&limit=500');
    expect(limited.map((r: any) => r.name)).toEqual(all.slice(3, 8).map((r: any) => r.name));
  });

  test('caps limit at 500', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'only', 'shared token', { tags: ['test'] });

    const payload = await requestJson('/api/search?q=token&space=proj&limit=10000');
    expect(payload.length).toBe(1);
  });

  test('space=* searches across all spaces', async () => {
    store = createTestStore();
    store.createSpace('proj-a', 'A', ['test']);
    store.createSpace('proj-b', 'B', ['test']);
    await store.addMemory('proj-a', 'a1', 'shared token', { tags: ['test'] });
    await store.addMemory('proj-b', 'b1', 'shared token', { tags: ['test'] });

    const payload = await requestJson('/api/search?q=token&space=*');
    expect(payload.map((r: any) => r.space_name).sort()).toEqual(['proj-a', 'proj-b']);
  });
});
