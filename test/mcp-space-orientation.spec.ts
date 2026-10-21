import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { createSpaceTools } from '../src/mcp/tools/spaces';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

const INTERNAL_KEYS = [
  'id',
  'space_name',
  'space_id',
  'content',
  'embedding',
  'access_count',
  'last_accessed_at',
  'created_at',
  'updated_at',
  'fts_id',
];

function expectNoInternalFields(memory: Record<string, unknown>) {
  for (const key of INTERNAL_KEYS) {
    expect(memory).not.toHaveProperty(key);
  }
}

describe('space_get orientation — living references', () => {
  test('returns living references and excludes non-living or partial tag matches', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);

    await store.addMemory('myproject', 'living-ref', 'Living reference content', {
      tier: 2,
      tags: ['type:reference', 'status:living', 'ref:architecture'],
    });
    await store.addMemory('myproject', 'reference-only', 'Reference without living status', {
      tags: ['type:reference'],
    });
    await store.addMemory('myproject', 'status-only', 'Living status without reference type', {
      tags: ['status:living'],
    });
    await store.addMemory('myproject', 'plain', 'Plain memory', { tags: ['cat:decision'] });

    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });

    expect(res.references.total).toBe(1);
    expect(res.references.returned_count).toBe(1);
    expect(res.references.coverage).toBe('complete');
    expect(res.references.memories).toHaveLength(1);

    const reference = res.references.memories[0] as Record<string, unknown>;
    expect(reference).toEqual(
      expect.objectContaining({
        name: 'living-ref',
        tier: 2,
        pinned: false,
        tags: expect.arrayContaining(['type:reference', 'status:living']),
        changed_at: expect.any(String),
      })
    );
    expectNoInternalFields(reference);
  });

  test('store.getLivingReferences applies pinned-first ordering and a bounded limit', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);

    await store.addMemory('myproject', 'older-pinned', 'Pinned reference', {
      tags: ['type:reference', 'status:living'],
      pinned: true,
    });
    for (let index = 0; index < 6; index += 1) {
      await store.addMemory('myproject', `living-${index}`, `Living reference ${index}`, {
        tags: ['type:reference', 'status:living'],
      });
    }

    const result = await store.getLivingReferences('myproject', 5);

    expect(result.total_count).toBe(7);
    expect(result.memories).toHaveLength(5);
    expect(result.memories[0]!.name).toBe('older-pinned');
    expect(result.memories[0]!.pinned).toBe(true);
  });

  test('marks references coverage as subset when more than the limit match', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);
    for (let index = 0; index < 6; index += 1) {
      await store.addMemory('myproject', `living-${index}`, `Living reference ${index}`, {
        tags: ['type:reference', 'status:living'],
      });
    }

    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });

    expect(res.references.total).toBe(6);
    expect(res.references.returned_count).toBe(5);
    expect(res.references.coverage).toBe('subset');
  });
});

describe('space_get orientation — checkpoint exclusion', () => {
  test('excludes checkpoints from trending tiers and references', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);

    await store.addMemory(
      'myproject',
      'checkpoint-1',
      JSON.stringify({ goal: 'Ship summary', pending: 'Keep parity', notes: '' }),
      {
        tier: 1,
        tags: ['checkpoint', 'active', 'type:reference', 'status:living'],
      }
    );
    await store.addMemory('myproject', 'hot1', 'Hot content', { tier: 1, tags: ['cat:decision'] });
    await store.addMemory('myproject', 'cold1', 'Cold content', { tier: 3, tags: ['test'] });

    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });

    expect(res.trending_memories.tier_1.total_count).toBe(1);
    expect(
      res.trending_memories.tier_1.memories.map((memory: { name: string }) => memory.name)
    ).toEqual(['hot1']);
    expect(res.trending_memories.tier_3.total_count).toBe(1);
    expect(res.references.total).toBe(0);
    expect(res.references.memories).toEqual([]);

    expect(res.overview).toEqual({
      total_memories: 3,
      active_checkpoints: 1,
      by_tier: [
        { tier: 1, count: 2, pinned: 0 },
        { tier: 2, count: 0, pinned: 0 },
        { tier: 3, count: 1, pinned: 0 },
      ],
    });
    expect(res.active_checkpoints.total).toBe(1);
    expect(res.active_checkpoints.checkpoints).toHaveLength(1);
  });
});

describe('space_get orientation — bounded trending', () => {
  test('orders pinned memories before unpinned memories in a tier preview', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);

    await store.addMemory('myproject', 'pinned-older', 'Pinned content', {
      tier: 2,
      tags: ['test'],
      pinned: true,
    });
    await store.addMemory('myproject', 'unpinned-newer', 'Unpinned content', {
      tier: 2,
      tags: ['test'],
    });

    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });

    expect(
      res.trending_memories.tier_2.memories.map((memory: { name: string }) => memory.name)
    ).toEqual(['pinned-older', 'unpinned-newer']);
  });

  test('returns a tier total and at most five previews without materializing the tier', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['type:project']);

    for (let index = 0; index < 12; index += 1) {
      await store.addMemory('myproject', `cold-${index}`, `Cold content ${index}`, {
        tier: 3,
        tags: ['test'],
      });
    }

    const queryMemoriesSpy = spyOn(store, 'queryMemories');
    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });
    queryMemoriesSpy.mockRestore();

    expect(res.trending_memories.tier_3.total_count).toBe(12);
    expect(res.trending_memories.tier_3.returned_count).toBe(5);
    expect(res.trending_memories.tier_3.memories).toHaveLength(5);
    expect(res.trending_memories.tier_3.coverage).toBe('subset');
    expect(queryMemoriesSpy).not.toHaveBeenCalled();
    for (const memory of res.trending_memories.tier_3.memories) {
      expectNoInternalFields(memory as Record<string, unknown>);
    }
  });
});
