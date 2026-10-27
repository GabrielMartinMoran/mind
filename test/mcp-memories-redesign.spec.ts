import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

// =============================================================================
// RED Phase: Tests for Phase 2.2 — Memories Tools Redesign
// These tests define the NEW expected behavior.
// =============================================================================

describe('Phase 2.2: Memories Tools Redesign', () => {
  beforeEach(() => {
    store = createTestStore();
    store.createSpace('test-space', 'Test space', ['test']);
  });

  // ==========================================================================
  // memory.add — tags REQUIRED
  // ==========================================================================
  describe('memory.add — tags REQUIRED', () => {
    test('2.2.1 memory.add without tags throws "tags is required"', async () => {
      const tools = createMemoryTools(store);

      await expect(
        tools.memory_add.handler({
          space: 'test-space',
          name: 'my-memory',
          content: 'Memory content',
        })
      ).rejects.toThrow('tags is required');
    });

    test('2.2.2 memory.add with empty tags [] throws error about tags requirement', async () => {
      const tools = createMemoryTools(store);

      await expect(
        tools.memory_add.handler({
          space: 'test-space',
          name: 'my-memory',
          content: 'Memory content',
          tags: [],
        })
      ).rejects.toThrow(/tags.*required|tags.*non-empty/i);
    });

    test('memory.add with valid tags succeeds', async () => {
      const tools = createMemoryTools(store);

      const res = await tools.memory_add.handler({
        space: 'test-space',
        name: 'my-memory',
        content: 'Memory content',
        tags: ['cat:decision'],
      });

      expect(res.memory?.tags).toContain('cat:decision');
      expect((res as any).structuredContent?.memory?.name).toBe('my-memory');
      expect((res.memory as Record<string, unknown>)?.id).toBeUndefined();
      expect(
        ((res as any).structuredContent?.memory as Record<string, unknown>)?.id
      ).toBeUndefined();
      expect(
        ((parseYaml(res.content[0]!.text) as { memory?: Record<string, unknown> }).memory ?? {}).id
      ).toBeUndefined();
      expect(res.memory?.space).toBe('test-space');
      expect((res.memory as Record<string, unknown>)?.space_name).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.access_count).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.last_accessed_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.embedding).toBeUndefined();
      expect(res.memory?.changed_at).toEqual(expect.any(String));
      expect((res.memory as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.updated_at).toBeUndefined();
    });
  });

  // ==========================================================================
  // memory.read noPromote:true — read without side effects (replaces old memory_get)
  // ==========================================================================
  describe('memory.read noPromote:true — read without side effects', () => {
    test('2.2.3 memory.read noPromote:true returns links_to and linked_by arrays', async () => {
      // Create target memories first
      await store.addMemory('test-space', 'target1', 'Target 1 content', { tags: ['test'] });
      const target = store.getMemory('test-space', 'target1')!;

      // Create source memory with link
      await store.addMemory('test-space', 'source1', 'Source content', {
        tags: ['test'],
        linksToIds: [target.id],
      });

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'source1',
        noPromote: true,
      });

      expect(res.memory?.space).toBe('test-space');
      expect((res.memory as Record<string, unknown>)?.space_name).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.access_count).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.last_accessed_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.embedding).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.updated_at).toBeUndefined();
      expect(res.links_to).toBeDefined();
      expect(Array.isArray(res.links_to)).toBe(true);
      expect(res.linked_by).toBeDefined();
      expect(Array.isArray(res.linked_by)).toBe(true);
    });

    test('2.2.4 memory.read noPromote:true links_to includes {ref, name, space, tier, tags, pinned, changed_at} (no id)', async () => {
      // Create target memory
      await store.addMemory('test-space', 'target1', 'Target content', {
        tags: ['cat:pattern'],
        pinned: true,
      });
      const target = store.getMemory('test-space', 'target1')!;

      // Create source with link to target
      await store.addMemory('test-space', 'source1', 'Source content', {
        tags: ['test'],
        linksToIds: [target.id],
      });

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'source1',
        noPromote: true,
      });

      const link = res.links_to[0];
      expect(link).toBeDefined();
      expect((link as any).id).toBeUndefined();
      expect(link!.ref).toBe('test-space:target1');
      expect(link!.name).toBe('target1');
      expect(link!.space).toBe('test-space');
      expect(link!.tier).toBe(target.tier);
      expect(link!.tags).toContain('cat:pattern');
      expect(link!.pinned).toBe(true);
      expect(typeof link!.changed_at).toBe('string');
      expect(link!.label).toBe('related');
      expect(link!.direction).toBe('outgoing');
    });
  });

  // ==========================================================================
  // memory.read — +tier_change, links_to, linked_by
  // ==========================================================================
  describe('memory.read — +tier_change, links_to, linked_by', () => {
    test('2.2.5 memory.read of memory in T2 returns tier_change with reason "auto-promote on read"', async () => {
      // Create T2 memory (default)
      await store.addMemory('test-space', 'warm-memory', 'Warm content', {
        tier: 2,
        tags: ['test'],
      });
      const memBefore = store.getMemory('test-space', 'warm-memory')!;
      expect(memBefore.tier).toBe(2);

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'warm-memory',
      });

      expect(res.tier_change).toBeDefined();
      expect(res.tier_change!.from).toBe(2);
      expect(res.tier_change!.to).toBe(1);
      expect(res.tier_change!.reason).toBe('auto-promote on read');
    });

    test('2.2.6 memory.read of memory in T1 returns tier_change with reason "already at T1"', async () => {
      // Create T1 memory
      await store.addMemory('test-space', 'hot-memory', 'Hot content', {
        tier: 1,
        tags: ['test'],
      });
      const memBefore = store.getMemory('test-space', 'hot-memory')!;
      expect(memBefore.tier).toBe(1);

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'hot-memory',
      });

      expect(res.tier_change).toBeDefined();
      expect(res.tier_change!.from).toBe(1);
      expect(res.tier_change!.to).toBe(1);
      expect(res.tier_change!.reason).toBe('already at T1');
    });

    test('2.2.7 memory.read of pinned memory does not promote (reason indicates pinned)', async () => {
      // Create pinned T2 memory
      await store.addMemory('test-space', 'pinned-memory', 'Pinned content', {
        tier: 2,
        tags: ['test'],
        pinned: true,
      });
      const memBefore = store.getMemory('test-space', 'pinned-memory')!;
      expect(memBefore.tier).toBe(2);
      expect(memBefore.pinned).toBe(true);

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'pinned-memory',
      });

      expect(res.tier_change).toBeDefined();
      expect(res.tier_change!.from).toBe(2);
      expect(res.tier_change!.to).toBe(2); // Not promoted
      expect(res.tier_change!.reason).toContain('pin');
    });

    test('memory.read returns links_to and linked_by', async () => {
      // Create target and source memories with link
      await store.addMemory('test-space', 'target1', 'Target content', { tags: ['test'] });
      const target = store.getMemory('test-space', 'target1')!;

      await store.addMemory('test-space', 'source1', 'Source content', {
        tags: ['test'],
        linksToIds: [target.id],
      });

      const tools = createMemoryTools(store);
      const res = await tools.memory_read.handler({
        space: 'test-space',
        name: 'source1',
      });

      expect(res.links_to).toBeDefined();
      expect(Array.isArray(res.links_to)).toBe(true);
      expect(res.linked_by).toBeDefined();
      expect(Array.isArray(res.linked_by)).toBe(true);
    });
  });

  // ==========================================================================
  // memory.update — tags optional
  // ==========================================================================
  describe('memory.update — by space+name', () => {
    test('2.2.8 memory.update with tags replaces entire array', async () => {
      await store.addMemory('test-space', 'my-memory', 'Content', {
        tags: ['cat:decision', 'cat:pattern'],
      });

      const tools = createMemoryTools(store);
      await tools.memory_update.handler({
        space: 'test-space',
        name: 'my-memory',
        content: 'Updated content',
        tags: ['new:tag'],
      });

      const updated = store.getMemory('test-space', 'my-memory');
      expect(updated?.tags).toEqual(['new:tag']);
    });

    test('2.2.9 memory.update without tags does not modify existing tags', async () => {
      await store.addMemory('test-space', 'my-memory', 'Content', {
        tags: ['cat:decision', 'cat:pattern'],
      });

      const tools = createMemoryTools(store);
      await tools.memory_update.handler({
        space: 'test-space',
        name: 'my-memory',
        content: 'Updated content',
      });

      const updated = store.getMemory('test-space', 'my-memory');
      expect(updated?.tags).toEqual(['cat:decision', 'cat:pattern']);
    });

    test('memory.update accepts space, name, and content', async () => {
      await store.addMemory('test-space', 'my-memory', 'Content', { tags: ['test'] });

      const tools = createMemoryTools(store);
      const res = await tools.memory_update.handler({
        space: 'test-space',
        name: 'my-memory',
        content: 'New content',
      });

      const updated = store.getMemory('test-space', 'my-memory');
      expect(updated?.content).toBe('New content');
      expect((res as any).structuredContent?.memory?.content).toBe('New content');
      expect(res.memory?.space).toBe('test-space');
      expect((res.memory as Record<string, unknown>)?.space_name).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.access_count).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.last_accessed_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.embedding).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.created_at).toBeUndefined();
      expect((res.memory as Record<string, unknown>)?.updated_at).toBeUndefined();
      expect(res.memory?.changed_at).toEqual(expect.any(String));
    });
  });

  describe('memory.query — MCP payload cleanup', () => {
    test('memory.query omits access-based internal fields', async () => {
      await store.addMemory('test-space', 'query-memory', 'Content', { tags: ['test'] });

      const tools = createMemoryTools(store);
      const res = await tools.memory_query.handler({ space: 'test-space', limit: 10, offset: 0 });

      expect(res.memories).toHaveLength(1);
      expect(res.memories[0]?.changed_at).toEqual(expect.any(String));
      expect((res.memories[0] as Record<string, unknown>)?.access_count).toBeUndefined();
      expect((res.memories[0] as Record<string, unknown>)?.last_accessed_at).toBeUndefined();
    });
  });

  // ==========================================================================
  // memory.delete — unchanged (but verify space:name format works)
  // ==========================================================================
  describe('memory.delete — unchanged', () => {
    test('2.2.10 memory.delete with space:name format works', async () => {
      await store.addMemory('test-space', 'to-delete', 'Content', { tags: ['test'] });

      const tools = createMemoryTools(store);
      const res = await tools.memory_delete.handler({
        space: 'test-space',
        name: 'to-delete',
      });

      expect(res.content[0]?.text).toContain('deleted');
      expect(store.getMemory('test-space', 'to-delete')).toBeNull();
    });
  });

  // ==========================================================================
  // Removed tools — should NOT exist
  // ==========================================================================
  describe('Removed tools — memory_get, memory_get_by_id, memory_list', () => {
    test('2.2.0 memory_get no longer exists (tool removed — use memory_read with noPromote:true instead)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_get).toBeUndefined();
    });

    test('2.2.11 memory_get_by_id no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_get_by_id).toBeUndefined();
    });

    test('2.2.12 memory_list no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_list).toBeUndefined();
    });

    test('memory_tag_add no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_tag_add).toBeUndefined();
    });

    test('memory_tag_remove no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_tag_remove).toBeUndefined();
    });

    test('memory_tags_list no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_tags_list).toBeUndefined();
    });

    test('memory_patch no longer exists (tool not found)', async () => {
      const tools = createMemoryTools(store);
      expect((tools as any).memory_patch).toBeUndefined();
    });
  });
});
