// ── Search parity: HTTP /api/search vs MCP memory_query(search) ──
//
// The web search surface must rank exactly like the MCP surface: both go
// through the same unified pipeline and must return the same order, score,
// confidence and methods for the same corpus, query and filters. The lexical
// cases run without RAG (no paid calls); the semantic cases replace the
// embedding provider with a deterministic in-process stub.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { matchApiRoute } from '../src/api/router';
import * as ragHelpers from '../src/helpers/rag';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: (MindStore & { cleanup: () => void }) | null = null;
const restorers: (() => void)[] = [];

// The compact/expanded contract must not depend on the invoking shell. Capture
// the ambient value once, force compact mode before every test so compact
// assertions always run with the flag absent, and restore the ambient value
// afterwards so this file never leaks env state into other suites.
const EXPANDED_RESPONSE_ENV = 'USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE';
const ambientExpandedResponse = process.env[EXPANDED_RESPONSE_ENV];

function restoreAmbientExpandedResponse(): void {
  if (ambientExpandedResponse === undefined) {
    delete process.env[EXPANDED_RESPONSE_ENV];
    return;
  }
  process.env[EXPANDED_RESPONSE_ENV] = ambientExpandedResponse;
}

function restoreAll(): void {
  for (const restore of restorers.splice(0)) restore();
  ragHelpers.resetSemanticBreaker();
}

beforeEach(() => {
  delete process.env[EXPANDED_RESPONSE_ENV];
});

afterEach(() => {
  store?.cleanup();
  store = null;
  restoreAmbientExpandedResponse();
  restoreAll();
});

async function httpSearch(path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  const res = await matchApiRoute(req, store!);
  if (!res) throw new Error('Route not matched');
  return res;
}

function enableRag(entries: [id: string, score: number][]) {
  const ragSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(true);
  const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue(
    entries.map(([id, score]) => ({ id, score }))
  );
  restorers.push(
    () => semanticSpy.mockRestore(),
    () => ragSpy.mockRestore()
  );
  return semanticSpy;
}

function seedParityCorpus(): MindStore & { cleanup: () => void } {
  const created = createTestStore();
  created.createSpace('projects/parity', 'Parity corpus', ['test']);
  return created;
}

async function seedLexical(created: MindStore): Promise<void> {
  await created.addMemory('projects/parity', 'auth-jwt', 'JWT authentication implementation', {
    tags: ['cat:decision'],
  });
  await created.addMemory(
    'projects/parity',
    'session-recovery',
    'renew signed credentials after expiry',
    { tags: ['cat:discovery'] }
  );
  await created.addMemory('projects/parity', 'auth-token', 'authentication token rotation', {
    tags: ['cat:decision'],
  });
  await created.addMemory('projects/parity', 'graph-render', 'canvas graph rendering', {
    tags: ['cat:pattern'],
  });
}

describe('HTTP /api/search — MCP parity', () => {
  test('same order by default; MCP is compact while HTTP keeps diagnostics', async () => {
    store = seedParityCorpus();
    await seedLexical(store);

    const response = await httpSearch('/api/search?q=authentication+token&space=projects%2Fparity');
    const httpResults = await response.json();

    const tools = createMemoryTools(store);
    const compact = await tools.memory_query.handler({
      space: 'projects/parity',
      search: 'authentication token',
    });

    expect(httpResults.map((result: any) => result.name)).toEqual(
      compact.memories.map((memory: any) => memory.name)
    );
    expect(httpResults.length).toBeGreaterThan(0);

    for (let i = 0; i < httpResults.length; i += 1) {
      const httpResult = httpResults[i];
      const mcpResult = compact.memories[i];
      // HTTP keeps the full diagnostics; compact MCP keeps only confidence.
      expect(httpResult).toHaveProperty('score');
      expect(httpResult).toHaveProperty('methods');
      expect(httpResult.confidence).toBe(mcpResult.confidence);
      expect(mcpResult).not.toHaveProperty('score');
      expect(mcpResult).not.toHaveProperty('methods');
    }

    expect(compact).not.toHaveProperty('search_method');
    expect(Number(response.headers.get('X-Total-Count'))).toBe(compact.total);

    // The exact opt-in restores score/methods parity with HTTP.
    process.env[EXPANDED_RESPONSE_ENV] = 'true';
    const expanded = await tools.memory_query.handler({
      space: 'projects/parity',
      search: 'authentication token',
    });
    expect(expanded.memories.map((memory: any) => memory.name)).toEqual(
      httpResults.map((result: any) => result.name)
    );
    for (let i = 0; i < httpResults.length; i += 1) {
      expect(httpResults[i].score).toBeCloseTo(expanded.memories[i].score, 10);
      expect(httpResults[i].methods).toEqual(expanded.memories[i].methods);
    }
  });

  test('same ranking and totals with tag and tier filters', async () => {
    store = seedParityCorpus();
    await seedLexical(store);

    const response = await httpSearch(
      '/api/search?q=authentication+token&space=projects%2Fparity&tag=cat%3Adecision&tier=2'
    );
    const httpResults = await response.json();

    const tools = createMemoryTools(store);
    const compact = await tools.memory_query.handler({
      space: 'projects/parity',
      search: 'authentication token',
      tag: 'cat:decision',
      tier: 2,
    });

    expect(httpResults.map((result: any) => result.name)).toEqual(
      compact.memories.map((memory: any) => memory.name)
    );
    for (let i = 0; i < httpResults.length; i += 1) {
      expect(httpResults[i].confidence).toBe(compact.memories[i].confidence);
      expect(httpResults[i]).toHaveProperty('score');
      expect(httpResults[i]).toHaveProperty('methods');
      expect(compact.memories[i]).not.toHaveProperty('score');
      expect(compact.memories[i]).not.toHaveProperty('methods');
    }
    expect(Number(response.headers.get('X-Total-Count'))).toBe(compact.total);
  });

  test('semantic=off skips the semantic channel; semantic=on and MCP use it', async () => {
    store = seedParityCorpus();
    // Seed before enabling RAG so no embedding is requested during writes.
    await store.addMemory('projects/parity', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'projects/parity',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );

    const semanticSpy = enableRag([[paraphrase.id, 0.72]]);

    const offResponse = await httpSearch(
      '/api/search?q=authentication+token&space=projects%2Fparity&semantic=off'
    );
    const offResults = await offResponse.json();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(offResults.map((result: any) => result.name)).not.toContain('session-recovery');

    const onResponse = await httpSearch(
      '/api/search?q=authentication+token&space=projects%2Fparity&semantic=on'
    );
    const onResults = await onResponse.json();
    expect(semanticSpy).toHaveBeenCalled();
    expect(onResults.map((result: any) => result.name)).toContain('session-recovery');

    // MCP keeps its current behavior: full pipeline, semantic channel included.
    semanticSpy.mockClear();
    const tools = createMemoryTools(store);
    const mcp = await tools.memory_query.handler({
      space: 'projects/parity',
      search: 'authentication token',
    });
    expect(semanticSpy).toHaveBeenCalled();
    expect(mcp.memories.map((memory: any) => memory.name)).toContain('session-recovery');

    // semantic=on and MCP rank identically, including the semantic candidate.
    expect(onResults.map((result: any) => result.name)).toEqual(
      mcp.memories.map((memory: any) => memory.name)
    );
  });
});
