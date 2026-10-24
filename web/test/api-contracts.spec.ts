import { afterEach, describe, expect, test } from 'bun:test';

import { getSpaceGraph } from '../src/api/graph.js';
import { clearLogs, listLogs } from '../src/api/logs.js';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  queryMemories,
  queryMemoryPage,
  updateMemory,
} from '../src/api/memories.js';
import { searchMemories } from '../src/api/search.js';
import { createSpace, deleteSpace, getSpace, listSpaces, updateSpace } from '../src/api/spaces.js';
import { listSpaceMemoryTags } from '../src/api/tags.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetch(body: unknown = {}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function parseCall(call: CapturedCall): { pathname: string; params: URLSearchParams } {
  const url = new URL(call.url, 'http://localhost');
  return { pathname: url.pathname, params: url.searchParams };
}

function bodyOf(call: CapturedCall): unknown {
  return call.init?.body ? JSON.parse(String(call.init.body)) : undefined;
}

describe('spaces API contract', () => {
  test('listSpaces builds the spaces URL with filters', async () => {
    const calls = installFetch([]);
    await listSpaces({ includeHidden: true, tag: 'cat:decision' });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/spaces');
    expect(params.get('includeHidden')).toBe('true');
    expect(params.get('tag')).toBe('cat:decision');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  test('getSpace encodes the space name', async () => {
    const calls = installFetch({ name: 'Project Alpha' });
    await getSpace('Project Alpha');

    expect(parseCall(calls[0]!).pathname).toBe('/api/spaces/Project%20Alpha');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  test('createSpace posts the body and updateSpace patches it', async () => {
    const createCalls = installFetch({ name: 'demo' });
    await createSpace({ name: 'demo', description: 'Desc', tags: ['a'] });
    expect(parseCall(createCalls[0]!).pathname).toBe('/api/spaces');
    expect(createCalls[0]!.init?.method).toBe('POST');
    expect(bodyOf(createCalls[0]!)).toEqual({ name: 'demo', description: 'Desc', tags: ['a'] });

    const updateCalls = installFetch({ name: 'demo' });
    await updateSpace('demo', { description: 'New' });
    expect(parseCall(updateCalls[0]!).pathname).toBe('/api/spaces/demo');
    expect(updateCalls[0]!.init?.method).toBe('PATCH');
    expect(bodyOf(updateCalls[0]!)).toEqual({ description: 'New' });
  });

  test('deleteSpace uses DELETE', async () => {
    const calls = installFetch({ ok: true });
    await deleteSpace('demo');

    expect(parseCall(calls[0]!).pathname).toBe('/api/spaces/demo');
    expect(calls[0]!.init?.method).toBe('DELETE');
  });

  test('listSpaceMemoryTags encodes the space and forwards the abort signal', async () => {
    const calls = installFetch(['alpha', 'beta']);
    const controller = new AbortController();

    const tags = await listSpaceMemoryTags('projects/mind', { signal: controller.signal });

    expect(parseCall(calls[0]!).pathname).toBe('/api/spaces/projects%2Fmind/tags');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(tags).toEqual(['alpha', 'beta']);
  });
});

describe('memories API contract', () => {
  test('listMemories builds the space memories URL', async () => {
    const calls = installFetch([]);
    await listMemories('projects/mind', { tier: 2, tag: 'a' });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/spaces/projects%2Fmind/memories');
    expect(params.get('tier')).toBe('2');
    expect(params.get('tag')).toBe('a');
  });

  test('queryMemories builds the unified query URL', async () => {
    const calls = installFetch([]);
    await queryMemories({
      space: 'projects/mind',
      tag: 'a',
      tier: 3,
      from: '2024-01-01',
      to: '2024-12-31',
      limit: 10,
      offset: 5,
    });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/memories/query');
    expect(params.get('space')).toBe('projects/mind');
    expect(params.get('tag')).toBe('a');
    expect(params.get('tier')).toBe('3');
    expect(params.get('from')).toBe('2024-01-01');
    expect(params.get('to')).toBe('2024-12-31');
    expect(params.get('limit')).toBe('10');
    expect(params.get('offset')).toBe('5');
  });

  test('queryMemoryPage returns the items plus the X-Total-Count header total', async () => {
    const calls: CapturedCall[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([{ name: 'a' }, { name: 'b' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '250' },
      });
    }) as typeof fetch;

    const page = await queryMemoryPage({ space: 'projects/mind', limit: 100, offset: 0 });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/memories/query');
    expect(params.get('space')).toBe('projects/mind');
    expect(params.get('limit')).toBe('100');
    expect(params.get('offset')).toBe('0');
    expect(page).toEqual({ items: [{ name: 'a' }, { name: 'b' }], total: 250 });
  });

  test('queryMemoryPage falls back to the item count when the total header is absent', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ name: 'a' }, { name: 'b' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const page = await queryMemoryPage({ space: 'projects/mind' });

    expect(page).toEqual({ items: [{ name: 'a' }, { name: 'b' }], total: 2 });
  });

  test('getMemory encodes both path segments', async () => {
    const calls = installFetch({ name: 'Task A' });
    await getMemory('Project Alpha', 'Task A');

    expect(parseCall(calls[0]!).pathname).toBe('/api/spaces/Project%20Alpha/memories/Task%20A');
  });

  test('createMemory posts, updateMemory patches and deleteMemory deletes', async () => {
    const createCalls = installFetch({ name: 'm' });
    await createMemory('demo', { name: 'm', content: 'c', tags: ['a'], tier: 2 });
    expect(parseCall(createCalls[0]!).pathname).toBe('/api/spaces/demo/memories');
    expect(createCalls[0]!.init?.method).toBe('POST');
    expect(bodyOf(createCalls[0]!)).toEqual({
      name: 'm',
      content: 'c',
      tags: ['a'],
      tier: 2,
    });

    const updateCalls = installFetch({ name: 'm' });
    await updateMemory('demo', 'm', { content: 'next' });
    expect(parseCall(updateCalls[0]!).pathname).toBe('/api/spaces/demo/memories/m');
    expect(updateCalls[0]!.init?.method).toBe('PATCH');
    expect(bodyOf(updateCalls[0]!)).toEqual({ content: 'next' });

    const deleteCalls = installFetch({ ok: true });
    await deleteMemory('demo', 'm');
    expect(parseCall(deleteCalls[0]!).pathname).toBe('/api/spaces/demo/memories/m');
    expect(deleteCalls[0]!.init?.method).toBe('DELETE');
  });
});

describe('graph and logs API contract', () => {
  test('getSpaceGraph adds the optional limit', async () => {
    const calls = installFetch({ nodes: [] });
    await getSpaceGraph('projects/mind', { limit: 300 });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/spaces/projects%2Fmind/graph');
    expect(params.get('limit')).toBe('300');
  });

  test('listLogs forwards filters and clearLogs deletes the log collection', async () => {
    const listCalls = installFetch({ logs: [], total: 0, limit: 100, offset: 0 });
    await listLogs({
      source: 'cli',
      operation: 'read',
      search: 'auth',
      from: 'a',
      to: 'b',
      level: 'info',
      limit: 25,
      offset: 50,
      order: 'desc',
      since: 10,
    });

    const { pathname, params } = parseCall(listCalls[0]!);
    expect(pathname).toBe('/api/logs');
    expect(params.get('source')).toBe('cli');
    expect(params.get('operation')).toBe('read');
    expect(params.get('search')).toBe('auth');
    expect(params.get('from')).toBe('a');
    expect(params.get('to')).toBe('b');
    expect(params.get('level')).toBe('info');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');
    expect(params.get('order')).toBe('desc');
    expect(params.get('since')).toBe('10');

    const clearCalls = installFetch({ deleted: 2 });
    await clearLogs();
    expect(parseCall(clearCalls[0]!).pathname).toBe('/api/logs');
    expect(clearCalls[0]!.init?.method).toBe('DELETE');
  });
});

describe('search API contract', () => {
  test('sends the supported search params and parses total headers', async () => {
    const calls: CapturedCall[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([{ name: 'match' }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Total-Count': '42',
          'X-Has-More': 'true',
        },
      });
    }) as typeof fetch;

    const result = await searchMemories({
      q: 'auth',
      space: 'projects/mind',
      tag: 'cat:decision',
      tier: 2,
      confidence: 'high',
      semantic: true,
      limit: 25,
      offset: 50,
    });

    const { pathname, params } = parseCall(calls[0]!);
    expect(pathname).toBe('/api/search');
    expect(params.get('q')).toBe('auth');
    expect(params.get('space')).toBe('projects/mind');
    expect(params.get('tag')).toBe('cat:decision');
    expect(params.get('tier')).toBe('2');
    expect(params.get('confidence')).toBe('high');
    expect(params.get('semantic')).toBe('on');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');

    expect(result).toEqual({
      results: [{ name: 'match' }],
      total: 42,
      hasMore: true,
    });
  });

  test('serializes semantic as on/off and omits it when unspecified', async () => {
    const calls = installFetch([]);

    await searchMemories({ q: 'auth', semantic: false });
    await searchMemories({ q: 'auth', semantic: 'off' });
    await searchMemories({ q: 'auth' });

    expect(parseCall(calls[0]!).params.get('semantic')).toBe('off');
    expect(parseCall(calls[1]!).params.get('semantic')).toBe('off');
    expect(parseCall(calls[2]!).params.has('semantic')).toBe(false);
  });

  test('falls back when total headers are absent', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ name: 'a' }, { name: 'b' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const result = await searchMemories({ q: 'auth' });

    expect(result).toEqual({
      results: [{ name: 'a' }, { name: 'b' }],
      total: 2,
      hasMore: false,
    });
  });

  test('forwards the abort signal', async () => {
    let forwardedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => {
      forwardedSignal = init?.signal;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const controller = new AbortController();
    await searchMemories({ q: 'auth' }, { signal: controller.signal });

    expect(forwardedSignal).toBe(controller.signal);
  });
});
