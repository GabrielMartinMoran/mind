import { afterEach, describe, expect, test } from 'bun:test';

import { matchApiRoute } from '../src/api/router';
import { handleRequest } from '../src/api/server';
import type { MindStore } from '../src/store/mind-store';
import { EMPTY_SEARCH_QUERY_MESSAGE } from '../src/store/shared/search-query-error';

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

async function requestResponse(path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await matchApiRoute(req, store);
  if (!res) throw new Error('Route not matched');
  return res;
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

describe('API Routes — Spaces', () => {
  test('GET /api/spaces returns additive per-tier counts for every space', async () => {
    store = createTestStore();
    store.createSpace('mixed', 'Mixed tiers', ['test']);
    await store.addMemory('mixed', 'hot', 'hot content', { tier: 1, tags: ['test'] });
    await store.addMemory('mixed', 'warm-a', 'warm content', { tier: 2, tags: ['test'] });
    await store.addMemory('mixed', 'warm-b', 'more warm content', { tier: 2, tags: ['test'] });
    store.createSpace('empty', 'Empty space', ['test']);

    const payload = await requestJson('/api/spaces');

    expect(payload).toHaveLength(2);

    const mixed = payload.find((space: any) => space.name === 'mixed');
    expect(mixed.memory_count).toBe(3);
    expect(mixed.tier_counts).toEqual({ t1: 1, t2: 2, t3: 0 });
    expect(mixed.tier_counts.t1 + mixed.tier_counts.t2 + mixed.tier_counts.t3).toBe(
      mixed.memory_count
    );

    const empty = payload.find((space: any) => space.name === 'empty');
    expect(empty.memory_count).toBe(0);
    expect(empty.tier_counts).toEqual({ t1: 0, t2: 0, t3: 0 });
  });

  test('GET /api/spaces keeps existing keys additive to tier_counts', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);

    const [space] = await requestJson('/api/spaces');

    expect(Object.keys(space).sort()).toEqual(
      ['description', 'hidden', 'memory_count', 'name', 'tags', 'tier_counts'].sort()
    );
    expect(space.hidden).toBe(false);
    expect(space.tags).toEqual(['test']);
  });
});

describe('API Routes — Space Tags', () => {
  test('returns a sorted bare array of memory tags for an encoded space name', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind', ['space-only']);
    await store.addMemory('projects/mind', 'hot', 'content', { tier: 1, tags: ['zeta', 'alpha'] });
    await store.addMemory('projects/mind', 'cold', 'content', { tier: 3, tags: ['beta'] });

    const payload = await requestJson('/api/spaces/projects%2Fmind/tags');

    expect(payload).toEqual(['alpha', 'beta', 'zeta']);
  });

  test('returns HTTP 200 with an empty array for an unknown space', async () => {
    store = createTestStore();

    const response = await requestResponse('/api/spaces/missing/tags');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
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

  test('GET /api/logs preserves agent attribution from caller_info', async () => {
    store = createTestStore();

    store.addLog({
      source: 'mcp',
      operation: 'memory_add',
      callerInfo: {
        agent: 'opencode',
        agentSource: 'env',
        clientName: 'opencode',
        clientVersion: '1.2.3',
        transport: 'stdio',
        mcpSession: 'sess-1',
      },
    });

    const payload = await requestJson('/api/logs?source=mcp');
    expect(payload.logs).toHaveLength(1);

    const row = payload.logs[0]!;
    // The route forwards the stored TEXT column; accept either a JSON string
    // or an already-parsed object so the contract is explicit about the value.
    const caller =
      typeof row.caller_info === 'string' ? JSON.parse(row.caller_info) : row.caller_info;
    expect(caller.agent).toBe('opencode');
    expect(caller.agentSource).toBe('env');
    expect(caller.transport).toBe('stdio');
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
    ['/src/app.js', 'application/javascript', "import { getSpaceGraph } from './api/graph.js';"],
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

  test('unknown API routes return JSON 404 instead of the SPA shell', async () => {
    store = createTestStore();

    const response = await requestThroughServer('/api/unknown');
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(typeof payload.error).toBe('string');
  });

  test('non-API deep links still serve the SPA shell', async () => {
    store = createTestStore();

    const response = await requestThroughServer('/totally/unknown/path');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<!doctype html>');
  });
});

describe('API Routes — Memory detail presenter', () => {
  test('returns UI fields and omits persistence internals', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'auth-jwt', 'JWT authentication', { tags: ['test'] });

    const payload = await requestJson('/api/spaces/proj/memories/auth-jwt');

    expect(payload.embedding).toBeUndefined();
    expect(payload.fts_id).toBeUndefined();
    expect(payload.space_id).toBeUndefined();

    expect(payload.name).toBe('auth-jwt');
    expect(payload.space_name).toBe('proj');
    expect(payload.content).toBe('JWT authentication');
    expect(payload.tier).toBe(2);
    expect(payload.pinned).toBe(false);
    expect(typeof payload.access_count).toBe('number');
    expect(payload.last_accessed_at).toBeNull();
    expect(payload.tags).toEqual(['test']);
    expect(typeof payload.created_at).toBe('string');
    expect(typeof payload.updated_at).toBe('string');
    expect(typeof payload.changed_at).toBe('string');
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

  test('filters by confidence after fusion and reports the filtered total', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'full', 'authentication token rotation', { tags: ['test'] });
    await store.addMemory('proj', 'split', 'token rotation authentication', { tags: ['test'] });

    const unfiltered = await requestJson('/api/search?q=authentication+token&space=proj');
    expect(new Set(unfiltered.map((r: any) => r.confidence))).toEqual(new Set(['high', 'medium']));

    const response = await requestResponse(
      '/api/search?q=authentication+token&space=proj&confidence=medium'
    );
    const payload = await response.json();

    expect(payload.map((r: any) => r.name)).toEqual(['split']);
    expect(payload.every((r: any) => r.confidence === 'medium')).toBe(true);
    expect(response.headers.get('X-Total-Count')).toBe('1');
  });

  test('ignores invalid confidence values', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'full', 'authentication token rotation', { tags: ['test'] });
    await store.addMemory('proj', 'split', 'token rotation authentication', { tags: ['test'] });

    const baseline = await requestJson('/api/search?q=authentication+token&space=proj');
    const invalid = await requestJson(
      '/api/search?q=authentication+token&space=proj&confidence=urgent'
    );

    expect(invalid.map((r: any) => r.name)).toEqual(baseline.map((r: any) => r.name));
  });

  test('exposes X-Total-Count and X-Has-More for pagination', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    for (let i = 0; i < 30; i++) {
      await store.addMemory('proj', `m${i}`, 'shared token content', { tags: ['test'] });
    }

    const firstPage = await requestResponse('/api/search?q=token&space=proj');
    expect((await firstPage.json()).length).toBe(25);
    expect(firstPage.headers.get('X-Total-Count')).toBe('30');
    expect(firstPage.headers.get('X-Has-More')).toBe('true');

    const lastPage = await requestResponse('/api/search?q=token&space=proj&limit=10&offset=25');
    expect((await lastPage.json()).length).toBe(5);
    expect(lastPage.headers.get('X-Total-Count')).toBe('30');
    expect(lastPage.headers.get('X-Has-More')).toBe('false');
  });

  test('exposes zero totals for empty results', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'only', 'shared token', { tags: ['test'] });

    const response = await requestResponse('/api/search?q=zzznonexistent&space=proj');
    const payload = await response.json();

    expect(payload).toEqual([]);
    expect(response.headers.get('X-Total-Count')).toBe('0');
    expect(response.headers.get('X-Has-More')).toBe('false');
  });

  test('exposes zero totals when the query is empty', async () => {
    store = createTestStore();

    const response = await requestResponse('/api/search');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get('X-Total-Count')).toBe('0');
    expect(response.headers.get('X-Has-More')).toBe('false');
  });

  test('returns 400 with the shared message for an explicit empty or stopword-only q', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'stopword-doc', 'the and for de la', { tags: ['test'] });

    for (const path of [
      '/api/search?q=&space=proj',
      '/api/search?q=the+and+for+de+la&space=proj',
      '/api/search?q=%22the+and+for%22&space=proj',
    ]) {
      const response = await requestResponse(path);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: EMPTY_SEARCH_QUERY_MESSAGE });
    }
  });

  test('does not validate an absent q even when other filters are present', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'one', 'content', { tags: ['test'] });

    const response = await requestResponse('/api/search?space=proj&tag=test');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get('X-Total-Count')).toBe('0');
  });

  test('parses and plumbs the semantic option without changing lexical order', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'full', 'authentication token rotation', { tags: ['test'] });
    await store.addMemory('proj', 'split', 'token rotation authentication', { tags: ['test'] });

    const seen: Array<Record<string, unknown>> = [];
    const original = store.searchPage.bind(store);
    store.searchPage = async (query, options) => {
      seen.push({ ...options });
      return original(query, options);
    };

    const baseline = await requestJson('/api/search?q=authentication+token&space=proj');
    await requestJson('/api/search?q=authentication+token&space=proj&semantic=on');
    await requestJson('/api/search?q=authentication+token&space=proj&semantic=off');
    await requestJson('/api/search?q=authentication+token&space=proj&semantic=maybe');

    expect(seen[0]!.semantic).toBeUndefined();
    expect(seen[1]!.semantic).toBe(true);
    expect(seen[2]!.semantic).toBe(false);
    // Invalid values fall back to the server default (current behavior).
    expect(seen[3]!.semantic).toBeUndefined();

    // With RAG off (test env), semantic=off must not perturb lexical ranking.
    const off = await requestJson('/api/search?q=authentication+token&space=proj&semantic=off');
    expect(off.map((r: any) => r.name)).toEqual(baseline.map((r: any) => r.name));
    expect(off.map((r: any) => r.confidence)).toEqual(baseline.map((r: any) => r.confidence));
    expect(off.map((r: any) => r.methods)).toEqual(baseline.map((r: any) => r.methods));
  });
});

describe('API Routes — Memory query pagination', () => {
  async function seedSpace(): Promise<void> {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    for (let i = 0; i < 6; i++) {
      await store.addMemory('proj', `m${i}`, `content ${i}`, {
        tier: i < 2 ? 1 : i < 4 ? 2 : 3,
        tags: i % 2 === 0 ? ['test', 'cat:decision'] : ['test'],
      });
    }
  }

  test('exposes the total matching rows before limit/offset', async () => {
    await seedSpace();

    const response = await requestResponse('/api/memories/query?space=proj&limit=2&offset=0');
    const page = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('6');
    expect(page).toHaveLength(2);

    const secondPage = await requestResponse('/api/memories/query?space=proj&limit=2&offset=2');
    const secondBody = await secondPage.json();

    expect(secondPage.headers.get('X-Total-Count')).toBe('6');
    expect(secondBody).toHaveLength(2);
    expect(secondBody.map((row: any) => row.name)).not.toEqual(page.map((row: any) => row.name));
  });

  test('counts respect tier and tag filters', async () => {
    await seedSpace();

    const tierResponse = await requestResponse('/api/memories/query?space=proj&tier=1');
    expect(tierResponse.headers.get('X-Total-Count')).toBe('2');
    expect(await tierResponse.json()).toHaveLength(2);

    const tagResponse = await requestResponse('/api/memories/query?space=proj&tag=cat:decision');
    expect(tagResponse.headers.get('X-Total-Count')).toBe('3');
    expect(await tagResponse.json()).toHaveLength(3);

    const combined = await requestResponse(
      '/api/memories/query?space=proj&tier=2&tag=cat:decision'
    );
    expect(combined.headers.get('X-Total-Count')).toBe('1');
    expect((await combined.json()).map((row: any) => row.name)).toEqual(['m2']);
  });

  test('keeps the flat array body shape', async () => {
    await seedSpace();

    const payload = await requestJson('/api/memories/query?space=proj&limit=1');
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(typeof payload[0].name).toBe('string');
  });
});

describe('API Routes — Multi-tier filters', () => {
  async function seedTiers(): Promise<void> {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    const rows = [
      { name: 't1a', tier: 1, tags: ['test', 'cat:decision'], content: 'shared tier one decision' },
      { name: 't1b', tier: 1, tags: ['test'], content: 'shared tier one plain' },
      { name: 't2a', tier: 2, tags: ['test', 'cat:decision'], content: 'shared tier two decision' },
      { name: 't2b', tier: 2, tags: ['test'], content: 'shared tier two plain' },
      {
        name: 't3a',
        tier: 3,
        tags: ['test', 'cat:decision'],
        content: 'shared tier three decision',
      },
      { name: 't3b', tier: 3, tags: ['test'], content: 'shared tier three plain' },
    ] as const;
    for (const row of rows) {
      await store.addMemory('proj', row.name, row.content, {
        tier: row.tier,
        tags: [...row.tags],
      });
    }
  }

  test('filters the memory query by an inclusive tier list', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tiers=1,3');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('4');
    expect(rows.map((row: any) => row.name).sort()).toEqual(['t1a', 't1b', 't3a', 't3b']);
  });

  test('drops invalid and duplicate tier values', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tiers=1,1,9,3');
    expect(response.headers.get('X-Total-Count')).toBe('4');
    expect((await response.json()).every((row: any) => row.tier !== 2)).toBe(true);
  });

  test('falls back to tier when tiers has no valid value', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tiers=9&tier=2');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('2');
    expect(rows.map((row: any) => row.name).sort()).toEqual(['t2a', 't2b']);
  });

  test('keeps the single-tier contract unchanged', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tier=2');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('2');
    expect(rows.every((row: any) => row.tier === 2)).toBe(true);
  });

  test('reflects multi-tier filters in pagination and counts', async () => {
    await seedTiers();

    const first = await requestResponse(
      '/api/memories/query?space=proj&tiers=1,3&limit=2&offset=0'
    );
    const second = await requestResponse(
      '/api/memories/query?space=proj&tiers=1,3&limit=2&offset=2'
    );
    const firstRows = await first.json();
    const secondRows = await second.json();

    expect(first.headers.get('X-Total-Count')).toBe('4');
    expect(second.headers.get('X-Total-Count')).toBe('4');
    expect(firstRows).toHaveLength(2);
    expect(secondRows).toHaveLength(2);
    expect(firstRows.map((row: any) => row.name)).not.toEqual(
      secondRows.map((row: any) => row.name)
    );
  });

  test('combines a tag filter with a tier list', async () => {
    await seedTiers();

    const response = await requestResponse(
      '/api/memories/query?space=proj&tiers=1,3&tag=cat:decision'
    );
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('2');
    expect(rows.map((row: any) => row.name).sort()).toEqual(['t1a', 't3a']);
  });

  test('restricts search to the tier list', async () => {
    await seedTiers();

    const response = await requestResponse('/api/search?q=shared&space=proj&tiers=1,3');
    const results = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('4');
    expect(results).toHaveLength(4);
    expect(results.every((result: any) => result.tier === 1 || result.tier === 3)).toBe(true);
  });

  test('keeps search single-tier behavior unchanged', async () => {
    await seedTiers();

    const response = await requestResponse('/api/search?q=shared&space=proj&tier=2');
    const results = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('2');
    expect(results.every((result: any) => result.tier === 2)).toBe(true);
  });

  // Non-integer tier values are invalid, so they are dropped rather than
  // treated as a fractional tier. A lone invalid value leaves no filter, which
  // returns every tier instead of an empty page.
  test('ignores a non-integer single tier and keeps every tier', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tier=2.5');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('6');
    expect(rows.map((row: any) => row.name).sort()).toEqual([
      't1a',
      't1b',
      't2a',
      't2b',
      't3a',
      't3b',
    ]);
  });

  test('ignores a non-integer tier list value and keeps every tier', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tiers=2.5');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('6');
    expect(rows.map((row: any) => row.name).sort()).toEqual([
      't1a',
      't1b',
      't2a',
      't2b',
      't3a',
      't3b',
    ]);
  });

  // Existing invalid-value semantics apply: invalid entries are dropped and the
  // valid subset is kept, so 1,2.5,3 behaves like 1,3.
  test('keeps the valid subset of a mixed tier list', async () => {
    await seedTiers();

    const response = await requestResponse('/api/memories/query?space=proj&tiers=1,2.5,3');
    const rows = await response.json();

    expect(response.headers.get('X-Total-Count')).toBe('4');
    expect(rows.map((row: any) => row.name).sort()).toEqual(['t1a', 't1b', 't3a', 't3b']);
  });
});
