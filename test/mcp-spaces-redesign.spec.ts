import { afterEach, describe, expect, test } from 'bun:test';

import { createSpaceTools } from '../src/mcp/tools/spaces';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

// =============================================================================
// RED Phase: Tests for Phase 2.1 — Spaces Tools Redesign
// These tests define the NEW expected behavior.
// =============================================================================

describe('Phase 2.1: Spaces Tools Redesign', () => {
  describe('space.create — tags REQUIRED', () => {
    test('2.1.1 space.create without tags throws "tags is required"', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      await expect(
        tools.space_create.handler({
          name: 'myproject',
          description: 'My project',
        })
      ).rejects.toThrow('tags is required');
    });

    test('2.1.2 space.create with empty tags [] throws "at least 1 tag"', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      await expect(
        tools.space_create.handler({
          name: 'myproject',
          description: 'My project',
          tags: [],
        })
      ).rejects.toThrow('at least 1 tag');
    });

    test('space.create with valid tags succeeds', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      const res = await tools.space_create.handler({
        name: 'myproject',
        description: 'My project',
        tags: ['type:project'],
      });

      expect(res.space?.tags).toContain('type:project');
      expect((res as any).structuredContent?.space?.name).toBe('myproject');
      expect(res.space?.changed_at).toEqual(expect.any(String));
      expect((res.space as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.space as Record<string, unknown>)?.updated_at).toBeUndefined();
    });
  });

  describe('space.get — orientation summary', () => {
    test('2.1.3 space.get returns overview counts, per-tier trending memories, and active_checkpoints', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['test']);
      await store.addMemory('myproject', 'hot-old', 'hot content', { tier: 1, tags: ['test'] });
      await store.addMemory('myproject', 'hot-new', 'newer hot content', {
        tier: 1,
        tags: ['test'],
      });
      await store.addMemory('myproject', 'warm1', 'warm content', { tier: 2, tags: ['test'] });
      await store.addMemory('myproject', 'cold1', 'cold content', { tier: 3, tags: ['test'] });
      await store.addMemory(
        'myproject',
        'checkpoint-1',
        JSON.stringify({ goal: 'Ship summary', pending: 'Keep parity', notes: '' }),
        { tier: 1, tags: ['checkpoint', 'active'] }
      );

      const tools = createSpaceTools(store);
      const res = await tools.space_get.handler({ name: 'myproject' });

      expect(res.overview).toEqual({
        total_memories: 5,
        active_checkpoints: 1,
        by_tier: [
          { tier: 1, count: 3, pinned: 0 },
          { tier: 2, count: 1, pinned: 0 },
          { tier: 3, count: 1, pinned: 0 },
        ],
      });

      expect(res.trending_memories.tier_1).toEqual({
        total_count: 2,
        returned_count: 2,
        coverage: 'complete',
        memories: [
          expect.objectContaining({ name: 'hot-new', tier: 1 }),
          expect.objectContaining({ name: 'hot-old', tier: 1 }),
        ],
      });
      expect(res.trending_memories.tier_2).toEqual({
        total_count: 1,
        returned_count: 1,
        coverage: 'complete',
        memories: [expect.objectContaining({ name: 'warm1', tier: 2 })],
      });
      expect(res.trending_memories.tier_3).toEqual({
        total_count: 1,
        returned_count: 1,
        coverage: 'complete',
        memories: [expect.objectContaining({ name: 'cold1', tier: 3 })],
      });

      expect(res.active_checkpoints.total).toBe(1);
      expect(res.active_checkpoints.checkpoints).toHaveLength(1);
      expect(res.active_checkpoints.checkpoints[0]).toEqual(
        expect.objectContaining({
          name: 'checkpoint-1',
          goal: 'Ship summary',
          pending: 'Keep parity',
          changed_at: expect.any(String),
          tags: expect.arrayContaining(['checkpoint', 'active']),
        })
      );
      expect(res.references).toEqual({
        total: 0,
        returned_count: 0,
        coverage: 'complete',
        memories: [],
      });
    });

    test('2.1.4 space.get trending tier blocks exclude checkpoint-tagged memories and internal access fields', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['test']);
      await store.addMemory('myproject', 'hot1', 'hot content', {
        tier: 1,
        tags: ['cat:decision'],
        pinned: true,
      });
      await store.addMemory(
        'myproject',
        'checkpoint-1',
        JSON.stringify({ goal: 'Ship summary', pending: 'Keep parity', notes: '' }),
        { tier: 1, tags: ['checkpoint', 'active'] }
      );

      const tools = createSpaceTools(store);
      const res = await tools.space_get.handler({ name: 'myproject' });

      const hot = res.trending_memories.tier_1.memories[0];
      expect(hot).toBeDefined();
      expect(res.active_checkpoints.checkpoints).toHaveLength(1);
      expect(res.space?.changed_at).toEqual(expect.any(String));
      expect((res.space as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.space as Record<string, unknown>)?.updated_at).toBeUndefined();
      expect((hot as any).id).toBeUndefined();
      expect(hot!.name).toBe('hot1');
      expect(hot!.tier).toBe(1);
      expect(hot!.tags).toContain('cat:decision');
      expect(hot!.pinned).toBe(true);
      expect(typeof hot!.changed_at).toBe('string');
      expect((hot as Record<string, unknown>)?.access_count).toBeUndefined();
      expect((hot as Record<string, unknown>)?.last_accessed_at).toBeUndefined();
      expect((hot as Record<string, unknown>)?.updated_at).toBeUndefined();
    });

    test('space.get marks empty tiers as complete coverage', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['test']);

      const tools = createSpaceTools(store);
      const res = await tools.space_get.handler({ name: 'myproject' });

      expect(res.trending_memories.tier_1).toEqual({
        total_count: 0,
        returned_count: 0,
        coverage: 'complete',
        memories: [],
      });
      expect(res.trending_memories.tier_2).toEqual({
        total_count: 0,
        returned_count: 0,
        coverage: 'complete',
        memories: [],
      });
      expect(res.trending_memories.tier_3).toEqual({
        total_count: 0,
        returned_count: 0,
        coverage: 'complete',
        memories: [],
      });
      expect(res.active_checkpoints).toEqual({ total: 0, checkpoints: [] });
      expect(res.references).toEqual({
        total: 0,
        returned_count: 0,
        coverage: 'complete',
        memories: [],
      });
    });

    test('space.get marks tier coverage as subset when the preview is truncated', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['test']);

      for (let index = 0; index < 6; index += 1) {
        await store.addMemory('myproject', `warm-${index}`, `warm content ${index}`, {
          tier: 2,
          tags: ['test'],
        });
      }

      const tools = createSpaceTools(store);
      const res = await tools.space_get.handler({ name: 'myproject' });

      expect(res.trending_memories.tier_2.total_count).toBe(6);
      expect(res.trending_memories.tier_2.returned_count).toBeLessThan(6);
      expect(res.trending_memories.tier_2.coverage).toBe('subset');
    });
  });

  describe('space.update — tags optional', () => {
    test('2.1.5 space.update with tags replaces entire array', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['type:project', 'cat:decision']);

      const tools = createSpaceTools(store);
      await tools.space_update.handler({
        name: 'myproject',
        tags: ['new:tag'],
      });

      const space = store.getSpace('myproject');
      expect(space?.tags).toEqual(['new:tag']);
    });

    test('2.1.6 space.update without tags does not modify existing tags', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['type:project', 'cat:decision']);

      const tools = createSpaceTools(store);
      const res = await tools.space_update.handler({
        name: 'myproject',
        description: 'Updated description',
      });

      const space = store.getSpace('myproject');
      // Tags order may vary due to DB storage, so sort before comparing
      expect(space?.tags.slice().sort()).toEqual(['cat:decision', 'type:project']);
      expect(res.space?.changed_at).toEqual(expect.any(String));
      expect((res.space as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.space as Record<string, unknown>)?.updated_at).toBeUndefined();
    });

    test('space.update with empty tags [] clears all tags', async () => {
      store = createTestStore();
      store.createSpace('myproject', 'My project', ['type:project']);

      const tools = createSpaceTools(store);
      await tools.space_update.handler({
        name: 'myproject',
        tags: [],
      });

      const space = store.getSpace('myproject');
      expect(space?.tags).toEqual([]);
    });
  });

  describe('Removed tools — space_rename, space_tag_add, space_tag_remove', () => {
    test('2.1.7 space_rename no longer exists (tool not found)', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      expect((tools as any).space_rename).toBeUndefined();
    });

    test('2.1.8 space_tag_add no longer exists (tool not found)', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      expect((tools as any).space_tag_add).toBeUndefined();
    });

    test('2.1.9 space_tag_remove no longer exists (tool not found)', async () => {
      store = createTestStore();
      const tools = createSpaceTools(store);

      expect((tools as any).space_tag_remove).toBeUndefined();
    });
  });
});
