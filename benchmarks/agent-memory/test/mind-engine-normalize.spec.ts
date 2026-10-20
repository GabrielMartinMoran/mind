import { describe, expect, test } from 'bun:test';

import { normalizeSearchItems } from '../src/engines/mind-normalize';
import { createMindV10Engine } from '../src/engines/mind-v10';
import { createMindV9Engine } from '../src/engines/mind-v9';
import type { MindPaths } from '../src/mind/cli';
import type { MindServerHandle } from '../src/mind/server';
import { createFakeRunner } from '../src/testing/fakes';

const paths: MindPaths = {
  dataDir: '/tmp/bench/cond',
  dbPath: '/tmp/bench/cond/mind.db',
  syncRoot: '/tmp/bench/cond/syncroot',
};

const v9Items = [
  { name: 'D1:1', space_name: 'locomo/conv-26', content: 'alpha', rank: -0.1 },
  { name: 'D1:2', space_name: 'locomo/conv-26', content: 'beta', rank: -0.2 },
];
const v10Items = [
  {
    name: 'D1:1',
    space_name: 'locomo/conv-26',
    content: 'alpha',
    rank: -0.1,
    score: 1,
    confidence: 'high',
    methods: ['all', 'trigram'],
  },
  { name: 'D1:2', space_name: 'locomo/conv-26', content: 'beta', rank: -0.2, score: 0.5 },
];

describe('normalizeSearchItems', () => {
  test('v9 normalises to nativeScoreKind=rank and preserves array order', () => {
    const rows = normalizeSearchItems(v9Items, 'v9');
    expect(rows.map(r => r.ref)).toEqual(['D1:1', 'D1:2']);
    expect(rows[0]!.nativeScoreKind).toBe('rank');
    expect(rows[0]!.nativeScore).toBeCloseTo(-0.1, 10);
    expect(rows[0]!.rankPosition).toBe(1);
    expect(rows[0]!.confidence).toBeUndefined();
  });

  test('v10 normalises to nativeScoreKind=score with confidence/methods', () => {
    const rows = normalizeSearchItems(v10Items, 'v10');
    expect(rows[0]!.nativeScoreKind).toBe('score');
    expect(rows[0]!.nativeScore).toBe(1);
    expect(rows[0]!.confidence).toBe('high');
    expect(rows[0]!.methods).toEqual(['all', 'trigram']);
    expect(rows[1]!.confidence).toBeUndefined();
  });

  test('drops items without a name and non-finite scores', () => {
    const rows = normalizeSearchItems(
      [{ content: 'no name' }, { name: 'D9:9', rank: Number.NaN }],
      'v9'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe('D9:9');
    expect(rows[0]!.nativeScore).toBeNull();
  });
});

function fakeServer(payload: unknown): {
  startServer: () => Promise<MindServerHandle>;
  fetchFn: typeof fetch;
  seenUrls: string[];
} {
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
    return { ok: true, status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  return { startServer: async () => handle, fetchFn, seenUrls };
}

describe('Mind engine adapters (searchRanked)', () => {
  test('v9 ignores the limit param and slices locally', async () => {
    const { runner } = createFakeRunner();
    const { startServer, fetchFn, seenUrls } = fakeServer(v9Items);
    const engine = createMindV9Engine({
      bin: '/w/v9/mind',
      paths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    const result = await engine.searchRanked('alpha', { limit: 25 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.nativeScoreKind).toBe('rank');
    expect(seenUrls[0]).not.toContain('limit=');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('v10 passes limit and maps score fields', async () => {
    const { runner } = createFakeRunner();
    const { startServer, fetchFn, seenUrls } = fakeServer(v10Items);
    const engine = createMindV10Engine({
      bin: '/w/v10/mind',
      paths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    const result = await engine.searchRanked('alpha', { limit: 25 });
    expect(result.rows[0]!.nativeScoreKind).toBe('score');
    expect(result.rows[0]!.confidence).toBe('high');
    expect(seenUrls[0]).toContain('limit=25');
    expect(seenUrls[0]).toContain('space=locomo%2Fconv-26');
  });

  test('search maps rows to EngineFragments with the ref as name/source', async () => {
    const { runner } = createFakeRunner();
    const { startServer, fetchFn } = fakeServer(v10Items);
    const engine = createMindV10Engine({
      bin: '/w/v10/mind',
      paths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    const result = await engine.search('locomo/conv-26', 'alpha', 1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.name).toBe('D1:1');
    expect(result.chunks[0]!.text).toBe('alpha');
    expect(result.nativeScoreKind).toBe('score');
  });

  test('retrieve falls back to a search by name', async () => {
    const { runner } = createFakeRunner();
    const { startServer, fetchFn } = fakeServer(v10Items);
    const engine = createMindV10Engine({
      bin: '/w/v10/mind',
      paths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    const found = await engine.retrieve!('locomo/conv-26', 'D1:2');
    expect(found?.text).toBe('beta');
    const missing = await engine.retrieve!('locomo/conv-26', 'D9:9');
    expect(missing).toBeNull();
  });
});

describe('Mind engine adapters (insert)', () => {
  test('insert runs add --tier 3 with the dia_id name and tags', async () => {
    const { runner, calls } = createFakeRunner(() => ({ stdout: 'ok', exitCode: 0 }));
    const { startServer, fetchFn } = fakeServer([]);
    const engine = createMindV10Engine({
      bin: '/w/v10/mind',
      paths,
      space: 'locomo/conv-26',
      runner,
      startServer,
      fetchFn,
    });

    await engine.insert('locomo/conv-26', 'content', {
      diaId: 'D1:1',
      tags: ['locomo', 'session:1'],
    });
    expect(calls[0]!.args).toEqual([
      'add',
      'locomo/conv-26',
      'D1:1',
      'content',
      '--tags',
      'locomo,session:1',
      '--tier',
      '3',
    ]);
  });
});
