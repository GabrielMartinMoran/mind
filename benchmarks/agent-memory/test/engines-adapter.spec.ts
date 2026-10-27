import { describe, expect, test } from 'bun:test';

import { engineForCondition } from '../src/config';
import type { MemoryEngine } from '../src/engines/adapter';
import { createMindCurrentEngine } from '../src/engines/mind-engine';
import type { MindPaths } from '../src/mind/cli';
import type { MindServerHandle } from '../src/mind/server';
import { createFakeEngine, createFakeRunner } from '../src/testing/fakes';

const currentPaths: MindPaths = {
  dataDir: '/tmp/bench/current',
  dbPath: '/tmp/bench/current/mind.db',
  syncRoot: '/tmp/bench/current/syncroot',
};

function fakeServer(payload: unknown): {
  startServer: () => Promise<MindServerHandle>;
  fetchFn: typeof fetch;
} {
  const handle: MindServerHandle = {
    port: 45000,
    baseUrl: 'http://127.0.0.1:45000',
    pid: 1234,
    stderr: () => '',
    stop: async () => undefined,
  };
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
  return { startServer: async () => handle, fetchFn };
}

// A conforming engine must implement the full lifecycle contract.
async function exerciseLifecycle(engine: MemoryEngine): Promise<void> {
  await engine.reset('run-1');
  const latency = await engine.insert('run-1', 'the quick brown fox', { diaId: 'D1:1' });
  expect(typeof latency).toBe('number');
  await engine.flush('run-1');
  const result = await engine.search('run-1', 'quick', 5);
  expect(Array.isArray(result.chunks)).toBe(true);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  await engine.cleanup('run-1');
}

describe('MemoryEngine contract', () => {
  test('a conforming (fake) engine satisfies the lifecycle', async () => {
    const engine = createFakeEngine();
    expect(engine.id).toBe('fake');
    await exerciseLifecycle(engine);
  });

  test('search returns normalised fragments within k', async () => {
    const engine = createFakeEngine();
    await engine.reset('run');
    await engine.insert('run', 'alpha beta');
    await engine.insert('run', 'alpha gamma');
    const result = await engine.search('run', 'alpha', 1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.text).toContain('alpha');
    expect(typeof result.chunks[0]!.score).toBe('number');
  });
});

describe('engineForCondition', () => {
  test('maps conditions to pinned engine labels', () => {
    expect(engineForCondition('no-memory')).toBeNull();
    expect(engineForCondition('mind-v9')).toBe('v9');
    expect(engineForCondition('mind-v10')).toBe('v10');
  });

  test('resolves mind-current to the local checkout engine', () => {
    expect(engineForCondition('mind-current')).toBe('current');
  });

  test('defaults to the current checkout condition', async () => {
    const { DEFAULT_CONDITIONS, CONDITIONS } = await import('../src/config');
    expect(DEFAULT_CONDITIONS).toEqual(['mind-current']);
    expect(CONDITIONS).toEqual(['no-memory', 'mind-v9', 'mind-v10', 'mind-current']);
  });
});

describe('current Mind engine adapter', () => {
  test('reports the current identity instead of simulating v10', async () => {
    const { runner } = createFakeRunner();
    const { startServer, fetchFn } = fakeServer([]);
    const engine = createMindCurrentEngine({
      bin: '/repo/mind',
      paths: currentPaths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    expect(engine.id).toBe('mind-current');
    expect(engine.version).toBe('current');
  });

  test('uses the current API contract (limit + score fields)', async () => {
    const { runner } = createFakeRunner();
    const seenUrls: string[] = [];
    const handle: MindServerHandle = {
      port: 45000,
      baseUrl: 'http://127.0.0.1:45000',
      pid: 1234,
      stderr: () => '',
      stop: async () => undefined,
    };
    const fetchFn = (async (url: string) => {
      seenUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            name: 'D1:1',
            space_name: 'locomo/conv-26',
            content: 'alpha',
            score: 1,
            confidence: 'high',
          },
        ],
      };
    }) as unknown as typeof fetch;
    const engine = createMindCurrentEngine({
      bin: '/repo/mind',
      paths: currentPaths,
      space: 'locomo/conv-26',
      runner,
      startServer: async () => handle,
      fetchFn,
    });

    const result = await engine.searchRanked('alpha', { limit: 25 });
    expect(seenUrls[0]).toContain('limit=25');
    expect(result.rows[0]!.nativeScoreKind).toBe('score');
    expect(result.rows[0]!.confidence).toBe('high');
  });
});
