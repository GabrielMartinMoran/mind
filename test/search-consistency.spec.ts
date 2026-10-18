import { afterEach, describe, expect, test } from 'bun:test';

import { matchApiRoute } from '../src/api/router';
import { executeCommand } from '../src/cli/command-executor';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { mockedLogger } from './mocks/mocked-logger';
import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

/** Seed a small corpus whose query matches span two spaces. */
async function seedCorpus(): Promise<void> {
  store = createTestStore();
  store.createSpace('csl-a', 'A', ['test']);
  store.createSpace('csl-b', 'B', ['test']);
  const docs: Array<[string, string, string]> = [
    ['csl-a', 'auth-jwt', 'JWT authentication with refresh tokens'],
    ['csl-a', 'auth-session', 'Session auth and authentication cookies'],
    ['csl-a', 'token-store', 'Token storage and authentication cache'],
    ['csl-b', 'auth-other', 'Authentication in another space'],
    ['csl-b', 'unrelated', 'Nothing relevant here'],
    ['csl-a', 'auth-jwt-extra', 'JWT authentication extras'],
  ];
  for (const [space, name, content] of docs) {
    await store.addMemory(space, name, content, { tags: ['test'] });
  }
}

async function mcpOrderedNames(space: string, query: string): Promise<string[]> {
  const tools = createMemoryTools(store);
  const res: any = await tools.memory_query.handler({ space, search: query });
  return res.memories.map((memory: any) => memory.name);
}

async function apiOrderedNames(space: string, query: string): Promise<string[]> {
  const url = `http://localhost/api/search?q=${encodeURIComponent(query)}&space=${encodeURIComponent(
    space
  )}`;
  const response = await matchApiRoute(new Request(url, { method: 'GET' }), store);
  if (!response) throw new Error('Search route not matched');
  const payload = (await response.json()) as Array<{ name: string }>;
  return payload.map(item => item.name);
}

async function cliOrderedNames(space: string, query: string): Promise<string[]> {
  const logger = mockedLogger();
  await executeCommand(['search', query, '--space', space], store, logger);
  const names: string[] = [];
  for (const log of logger.getLogs()) {
    const match = stripAnsi(log.message).match(/ \/ \[([^\]]+)\]/);
    if (match) names.push(match[1]!);
  }
  return names;
}

describe('Search cross-surface consistency', () => {
  test('CLI, MCP and API return the same ranking for the same query', async () => {
    await seedCorpus();

    const mcp = await mcpOrderedNames('csl-a', 'authentication');
    const api = await apiOrderedNames('csl-a', 'authentication');
    const cli = await cliOrderedNames('csl-a', 'authentication');

    expect(mcp.length).toBeGreaterThan(0);
    expect(api).toEqual(mcp);
    expect(cli).toEqual(mcp);
  });

  test('space "*" returns the same cross-space ranking through CLI, MCP and API', async () => {
    await seedCorpus();

    const mcp = await mcpOrderedNames('*', 'authentication');
    const api = await apiOrderedNames('*', 'authentication');
    const cli = await cliOrderedNames('*', 'authentication');

    expect(mcp).toContain('auth-other');
    expect(api).toEqual(mcp);
    expect(cli).toEqual(mcp);
  });
});
