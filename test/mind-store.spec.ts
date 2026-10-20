import { describe, expect, test, afterEach, spyOn } from 'bun:test';

import * as ragHelpers from '../src/helpers/rag';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

describe('MindStore — Spaces', () => {
  test('should create and retrieve a space', () => {
    store = createTestStore();
    store.createSpace('test', 'A test space', ['project', 'dev']);

    const space = store.getSpace('test');
    expect(space).not.toBeNull();
    expect(space!.name).toBe('test');
    expect(space!.description).toBe('A test space');
    expect(space!.tags).toContain('project');
    expect(space!.tags).toContain('dev');
  });

  test('should throw when creating duplicate space', () => {
    store = createTestStore();
    store.createSpace('test', 'A test space', ['test']);
    expect(() => {
      store.createSpace('test', 'Another', ['test']);
    }).toThrow('already exists');
  });

  test('should list spaces', () => {
    store = createTestStore();
    store.createSpace('alpha', 'First', ['test']);
    store.createSpace('beta', 'Second', ['test']);

    const spaces = store.listSpaces();
    expect(spaces.length).toBe(2);
    expect(spaces[0]!.name).toBe('alpha');
    expect(spaces[1]!.name).toBe('beta');
  });

  test('should list spaces filtered by tag', () => {
    store = createTestStore();
    store.createSpace('proj-a', 'Project A', ['project']);
    store.createSpace('personal', 'Personal', ['personal']);

    const projects = store.listSpaces({ tag: 'project' });
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe('proj-a');
  });

  test('should delete a space and all its memories', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    store.deleteSpace('test');

    expect(store.getSpace('test')).toBeNull();
  });

  test('should rename a space', async () => {
    store = createTestStore();
    store.createSpace('old', 'Old space', ['test']);
    await store.addMemory('old', 'mem1', 'content', { tags: ['test'] });
    store.renameSpace('old', 'new');

    expect(store.getSpace('old')).toBeNull();
    expect(store.getSpace('new')).not.toBeNull();
    // Memories should follow
    expect(store.getMemory('new', 'mem1')).not.toBeNull();
  });

  test('should update space description', () => {
    store = createTestStore();
    store.createSpace('test', 'Old description', ['test']);
    store.updateSpace('test', { description: 'New description' });

    const space = store.getSpace('test');
    expect(space!.description).toBe('New description');
  });

  test('should add and remove space tags', () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    store.addSpaceTag('test', 'project');
    store.addSpaceTag('test', 'active');

    let space = store.getSpace('test');
    expect(space!.tags).toContain('project');
    expect(space!.tags).toContain('active');

    store.removeSpaceTag('test', 'active');
    space = store.getSpace('test');
    expect(space!.tags).not.toContain('active');
    expect(space!.tags).toContain('project');
  });
});

describe('MindStore — Memories', () => {
  test('should add and retrieve a memory', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'auth-flow', 'JWT auth', {
      tags: ['backend', 'security'],
      tier: 1,
    });

    expect(mem.name).toBe('auth-flow');
    expect(mem.content).toBe('JWT auth');
    expect(mem.tier).toBe(1);
    expect(mem.tags).toContain('backend');
    expect(mem.tags).toContain('security');
    expect(mem.changed_at).toBeTruthy();

    const retrieved = store.getMemory('test', 'auth-flow');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(mem.id);
  });

  test('should not update changed_at on read access', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 3, tags: ['test'] });
    const before = store.getMemoryById(mem.id)!;

    await new Promise(resolve => setTimeout(resolve, 1100));
    store.recordAccess(mem.id);

    const after = store.getMemoryById(mem.id)!;
    expect(after.changed_at).toBe(before.changed_at);
    expect(after.tier).toBe(2); // still auto-promotes
  });

  test('should update changed_at on semantic memory changes', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const before = store.getMemoryById(mem.id)!;

    await new Promise(resolve => setTimeout(resolve, 1100));
    await store.updateMemory(mem.id, { content: 'new content' });

    const after = store.getMemoryById(mem.id)!;
    expect(after.changed_at).not.toBe(before.changed_at);
  });

  test('should default to tier 2', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    expect(mem.tier).toBe(2);
  });

  test('should list memories — default returns T1+T2 only', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'hot', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('test', 'warm', 'content', { tier: 2, tags: ['test'] });
    await store.addMemory('test', 'cold', 'content', { tier: 3, tags: ['test'] });

    const active = store.listMemories('test');
    expect(active.length).toBe(2);
    expect(active[0]!.tier).toBe(1);
    expect(active[1]!.tier).toBe(2);
    // cold (T3) should not appear
    expect(active.some(m => m.name === 'cold')).toBe(false);
  });

  test('should list memories — explicit tier 3 returns cold', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'hot', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('test', 'cold', 'content', { tier: 3, tags: ['test'] });

    const cold = store.listMemories('test', { tier: 3, tag: 'test' });
    expect(cold.length).toBe(1);
    expect(cold[0]!.name).toBe('cold');
  });

  test('should filter memories by tier', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'hot', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('test', 'warm', 'content', { tier: 2, tags: ['test'] });

    const tier1 = store.listMemories('test', { tier: 1, tag: 'test' });
    expect(tier1.length).toBe(1);
    expect(tier1[0]!.name).toBe('hot');
  });

  test('should filter memories by tag', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem1', 'content', { tags: ['backend'] });
    await store.addMemory('test', 'mem2', 'content', { tags: ['frontend'] });

    const backend = store.listMemories('test', { tag: 'backend' });
    expect(backend.length).toBe(1);
    expect(backend[0]!.name).toBe('mem1');
  });

  test('should update memory content', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'old content', { tags: ['test'] });
    await store.updateMemory(mem.id, { content: 'new content' });

    const updated = store.getMemoryById(mem.id);
    expect(updated!.content).toBe('new content');
  });

  test('should delete memory by name', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    store.deleteMemoryByName('test', 'mem1');
    expect(store.getMemory('test', 'mem1')).toBeNull();
  });

  test('should add and remove memory tags', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });

    store.addMemoryTag(mem.id, 'important');
    let retrieved = store.getMemoryById(mem.id);
    expect(retrieved!.tags).toContain('important');

    store.removeMemoryTag(mem.id, 'important');
    retrieved = store.getMemoryById(mem.id);
    expect(retrieved!.tags).not.toContain('important');
  });
});

describe('MindStore — Tiers', () => {
  test('should promote a memory', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 3, tags: ['test'] });

    store.promote(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(2);

    store.promote(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(1);
  });

  test('should not promote beyond tier 1', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 1, tags: ['test'] });
    expect(() => {
      store.promote(mem.id);
    }).toThrow('highest tier');
  });

  test('should demote a memory', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 1, tags: ['test'] });

    store.demote(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(2);

    store.demote(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(3);
  });

  test('should demote from T3 to T2 (T3 is now the lowest tier)', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 2, tags: ['test'] });
    store.demote(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(3);
  });

  test('should not demote beyond tier 3 (T3 is now the lowest tier)', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    // Add at T3 and try to demote - should throw since T3 is lowest
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 3, tags: ['test'] });
    expect(() => {
      store.demote(mem.id);
    }).toThrow('lowest tier');
  });

  test('should pin and unpin', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });

    store.pin(mem.id);
    expect(store.getMemoryById(mem.id)!.pinned).toBe(true);

    store.unpin(mem.id);
    expect(store.getMemoryById(mem.id)!.pinned).toBe(false);
  });

  test('should auto-promote tier 3 to 2 on read', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 2, tags: ['test'] });

    store.recordAccess(mem.id);
    expect(store.getMemoryById(mem.id)!.tier).toBe(1);
  });

  test('should not auto-promote pinned memory on read', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tier: 2, tags: ['test'] });
    store.pin(mem.id);

    store.recordAccess(mem.id);
    // Pinned: stays at T2
    expect(store.getMemoryById(mem.id)!.tier).toBe(2);
  });

  test('should bump access count on read', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });

    store.recordAccess(mem.id);
    store.recordAccess(mem.id);
    store.recordAccess(mem.id);

    const updated = store.getMemoryById(mem.id);
    expect(updated!.access_count).toBe(3);
    expect(updated!.last_accessed_at).not.toBeNull();
  });
});

describe('MindStore — LRU Eviction', () => {
  test('should evict LRU non-pinned memory when tier is full', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    // Fill T1 to limit (25)
    const { TIER_LIMITS } = require('../src/config');
    const limit: number = TIER_LIMITS[1];
    for (let i = 0; i < limit; i++) {
      await store.addMemory('test', `mem-${i}`, 'content', { tier: 1, tags: ['test'] });
    }

    // Adding one more to T1 should evict the LRU (mem-0) to T2
    await store.addMemory('test', 'overflow', 'content', { tier: 1, tags: ['test'] });

    // overflow was added to T1
    expect(store.getMemory('test', 'overflow')!.tier).toBe(1);
    // LRU (mem-0) was evicted to T2
    expect(store.getMemory('test', 'mem-0')!.tier).toBe(2);
    // Other T1 memories remain at T1
    expect(store.getMemory('test', 'mem-1')!.tier).toBe(1);
  });

  test('should throw when tier is full and all memories are pinned', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    const { TIER_LIMITS } = require('../src/config');
    const limit: number = TIER_LIMITS[1];

    // Fill T1 with pinned memories
    for (let i = 0; i < limit; i++) {
      const m = await store.addMemory('test', `pinned-${i}`, 'content', {
        tier: 1,
        tags: ['test'],
      });
      store.pin(m.id);
    }

    // Should throw — all T1 pinned
    await expect(
      store.addMemory('test', 'overflow', 'content', { tier: 1, tags: ['test'] })
    ).rejects.toThrow('pinned');
  });

  test('should not evict LRU from T3 (T3 is now unlimited)', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    // Add 100+ memories to T3 - T3 is unlimited, so no eviction
    for (let i = 0; i < 100; i++) {
      await store.addMemory('test', `cold-${i}`, 'content', { tier: 3, tags: ['test'] });
    }

    // Adding more to T3 should succeed with no eviction
    await store.addMemory('test', 'overflow', 'content', { tier: 3, tags: ['test'] });

    expect(store.getMemory('test', 'overflow')!.tier).toBe(3);
    expect(store.getMemory('test', 'cold-0')!.tier).toBe(3); // cold-0 should still be at T3
  });

  test('pinned memories should not be LRU-evicted', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    const { TIER_LIMITS } = require('../src/config');
    const limit: number = TIER_LIMITS[1];

    // Fill T1: first is pinned, rest are not
    const first = await store.addMemory('test', 'pinned-first', 'content', {
      tier: 1,
      tags: ['test'],
    });
    store.pin(first.id);
    for (let i = 1; i < limit; i++) {
      await store.addMemory('test', `mem-${i}`, 'content', { tier: 1, tags: ['test'] });
    }

    // Add overflow → should evict mem-1 (LRU non-pinned), NOT pinned-first
    await store.addMemory('test', 'overflow', 'content', { tier: 1, tags: ['test'] });

    expect(store.getMemory('test', 'pinned-first')!.tier).toBe(1); // still T1
    expect(store.getMemory('test', 'mem-1')!.tier).toBe(2); // evicted to T2
  });

  test('recordAccess promotion should silently skip if destination full and all pinned', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    const { TIER_LIMITS } = require('../src/config');
    const limit: number = TIER_LIMITS[1];

    // Fill T1 with pinned memories
    for (let i = 0; i < limit; i++) {
      const m = await store.addMemory('test', `pinned-${i}`, 'content', {
        tier: 1,
        tags: ['test'],
      });
      store.pin(m.id);
    }

    // Add a T2 memory and access it — promotion to T1 should silently fail
    const t2mem = await store.addMemory('test', 'warm', 'content', { tier: 2, tags: ['test'] });
    store.recordAccess(t2mem.id);

    // Should remain at T2 (not throw)
    expect(store.getMemory('test', 'warm')!.tier).toBe(2);
    // Access count should still bump
    expect(store.getMemory('test', 'warm')!.access_count).toBe(1);
  });
});

describe('MindStore — Space Graph', () => {
  test('should return graph nodes with minimal payload including T1-T3 and directed links', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const a = await store.addMemory('test', 'A', 'content', { tier: 1, tags: ['test'] });
    const b = await store.addMemory('test', 'B', 'content', { tier: 2, tags: ['test'] });
    const c = await store.addMemory('test', 'C', 'content', { tier: 3, tags: ['test'] });

    store.link(a.id, b.id);
    store.link(c.id, a.id);

    const graph = store.getSpaceGraph('test');
    expect(graph.nodes.length).toBe(3);
    expect(graph.meta.total_nodes).toBe(3);
    expect(graph.meta.truncated).toBe(false);

    const cNode = graph.nodes.find(node => node.id === c.id)!;
    expect(cNode.tier).toBe(3);
    expect(cNode.links_to).toEqual([a.id]);

    const aNode = graph.nodes.find(node => node.id === a.id)!;
    expect(aNode.links_to).toEqual([b.id]);
    expect(aNode.linked_by).toEqual([c.id]);
    expect(Object.keys(aNode).sort()).toEqual(['id', 'linked_by', 'links_to', 'name', 'tier']);
  });

  test('should enforce cap and expose truncation metadata', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    for (let i = 0; i < 10; i++) {
      await store.addMemory('test', `m-${i}`, 'content', { tier: 2, tags: ['test'] });
    }

    const graph = store.getSpaceGraph('test', { limit: 3, maxLimit: 5 });
    expect(graph.nodes.length).toBe(3);
    expect(graph.meta.requested_limit).toBe(3);
    expect(graph.meta.applied_limit).toBe(3);
    expect(graph.meta.max_limit).toBe(5);
    expect(graph.meta.total_nodes).toBe(10);
    expect(graph.meta.truncated).toBe(true);
  });
});

describe('MindStore — Status', () => {
  test('should return global status', async () => {
    store = createTestStore();
    store.createSpace('space1', 'Space 1', ['test']);
    store.createSpace('space2', 'Space 2', ['test']);
    await store.addMemory('space1', 'mem1', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('space1', 'mem2', 'content', { tier: 2, tags: ['test'] });
    await store.addMemory('space2', 'mem3', 'content', { tier: 3, tags: ['test'] });

    const status = store.getStatus();
    expect(status.total_spaces).toBe(2);
    expect(status.total_memories).toBe(3);
    expect(status.by_tier.length).toBe(3); // always 3 tiers
    expect(status.by_tier.find(b => b.tier === 1)!.count).toBe(1);
    expect(status.by_tier.find(b => b.tier === 2)!.count).toBe(1);
    expect(status.by_tier.find(b => b.tier === 3)!.count).toBe(1);
    expect(status.db_path).toContain('.db');
    expect(status.db_size_bytes).toBeGreaterThan(0);
  });

  test('should return space-scoped status', async () => {
    store = createTestStore();
    store.createSpace('space1', 'Space 1', ['test']);
    store.createSpace('space2', 'Space 2', ['test']);
    await store.addMemory('space1', 'mem1', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('space2', 'mem2', 'content', { tier: 2, tags: ['test'] });

    const status = store.getStatus('space1');
    expect(status.total_spaces).toBe(1);
    expect(status.total_memories).toBe(1);
    expect(status.by_tier.find(b => b.tier === 1)!.count).toBe(1);
    expect(status.by_tier.find(b => b.tier === 2)!.count).toBe(0);
  });

  test('should show pinned count in status', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const m1 = await store.addMemory('test', 'mem1', 'content', { tier: 1, tags: ['test'] });
    await store.addMemory('test', 'mem2', 'content', { tier: 1, tags: ['test'] });
    store.pin(m1.id);

    const status = store.getStatus('test');
    expect(status.by_tier.find(b => b.tier === 1)!.pinned).toBe(1);
    expect(status.by_tier.find(b => b.tier === 1)!.count).toBe(2);
  });
});

describe('MindStore — Links', () => {
  test('should create and retrieve links', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });

    store.link(mem1.id, mem2.id, 'depends-on');

    const links = store.getLinks(mem1.id);
    expect(links.length).toBe(1);
    expect(links[0]!.label).toBe('depends-on');
    expect(links[0]!.target_name).toBe('mem2');

    // Also visible from target side
    const links2 = store.getLinks(mem2.id);
    expect(links2.length).toBe(1);
  });

  test('should unlink memories', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });

    store.link(mem1.id, mem2.id);
    store.unlink(mem1.id, mem2.id);

    const links = store.getLinks(mem1.id);
    expect(links.length).toBe(0);
  });

  test('should not link a memory to itself', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });

    expect(() => {
      store.link(mem.id, mem.id);
    }).toThrow('itself');
  });

  test('should cascade delete links when memory is deleted', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });

    store.link(mem1.id, mem2.id);
    store.deleteMemory(mem1.id);

    const links = store.getLinks(mem2.id);
    expect(links.length).toBe(0);
  });
});

describe('MindStore — Search', () => {
  test('should find memories by full-text search', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth-flow', 'JWT authentication with refresh tokens', {
      tags: ['test'],
    });
    await store.addMemory('test', 'db-schema', 'PostgreSQL with Prisma ORM', { tags: ['test'] });

    const results = await store.search('authentication');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('auth-flow');
  });

  test('should search by name', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth-flow', 'some content', { tags: ['test'] });
    await store.addMemory('test', 'other', 'other content', { tags: ['test'] });

    const results = await store.search('auth');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('auth-flow');
  });

  test('should filter search by space', async () => {
    store = createTestStore();
    store.createSpace('proj-a', 'Project A', ['test']);
    store.createSpace('proj-b', 'Project B', ['test']);
    await store.addMemory('proj-a', 'auth', 'authentication', { tags: ['test'] });
    await store.addMemory('proj-b', 'auth', 'authentication', { tags: ['test'] });

    const results = await store.search('authentication', { space: 'proj-a' });
    expect(results.length).toBe(1);
    expect(results[0]!.space_name).toBe('proj-a');
  });

  test('should filter search by tier', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'hot-auth', 'authentication', { tier: 1, tags: ['test'] });
    await store.addMemory('test', 'cold-auth', 'authentication', { tier: 3, tags: ['test'] });

    const results = await store.search('authentication', { tier: 1, tag: 'test' });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('hot-auth');
  });

  test('should search T3 memories (T3 is now unlimited)', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'cold-auth', 'authentication token', {
      tier: 3,
      tags: ['test'],
    });

    const results = await store.search('authentication');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('cold-auth');
    expect(results[0]!.tier).toBe(3);
    // Verify similarity field exists (undefined when RAG disabled, number when enabled)
    expect('similarity' in results[0]!).toBe(true);
  });

  test('should return empty for no matches', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });

    const results = await store.search('nonexistent');
    expect(results.length).toBe(0);
  });

  test('LIKE fallback: searchFallback uses LIKE when FTS5 returns nothing for embedded substring', async () => {
    store = createTestStore();
    store.createSpace('projects/mind-test-fallback', 'Test', ['test']);
    await store.addMemory(
      'projects/mind-test-fallback',
      'test-memory',
      'something with xyzduablevalueembeddedxyz embedded',
      {
        tags: ['test'],
      }
    );

    const result = await store.searchFallback('duablevalue', {
      space: 'projects/mind-test-fallback',
    });
    expect(result.search_method).toBe('like');
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.name).toBe('test-memory');
  });

  test('should use deterministic hybrid order when RAG is enabled and FTS has hits', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth-a', 'authentication token', { tags: ['test'] });
    await store.addMemory('test', 'auth-b', 'authentication token', { tags: ['test'] });

    const ragEnabledSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(true);
    const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue([
      { id: store.getMemory('test', 'auth-b')!.id, score: 0.95 },
      { id: store.getMemory('test', 'auth-a')!.id, score: 0.1 },
    ]);

    const results = await store.search('authentication', { space: 'test' });
    expect(results.length).toBe(2);
    expect(results[0]!.name).toBe('auth-b');

    semanticSpy.mockRestore();
    ragEnabledSpy.mockRestore();
  });

  test('does not admit weak semantic fallback candidates when RAG is enabled', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'alpha', 'one', { tags: ['test'] });
    await store.addMemory('test', 'beta', 'two', { tags: ['test'] });

    const alphaId = store.getMemory('test', 'alpha')!.id;
    const betaId = store.getMemory('test', 'beta')!.id;

    const ragEnabledSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(true);
    const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue([
      { id: alphaId, score: 0.35 },
      { id: betaId, score: 0.25 },
    ]);

    // 0.35 clears the broad candidate floor (0.3) but not the semantic-only
    // admission floor (0.6), so the lexical last resort must not admit it.
    const results = await store.search('query-with-no-fts-hit', { space: 'test' });
    expect(results).toEqual([]);

    semanticSpy.mockRestore();
    ragEnabledSpy.mockRestore();
  });
});

describe('MindStore — Search relaxation ladder', () => {
  test('OR union returns memories matching either side', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'alpha', 'alpha content', { tags: ['test'] });
    await store.addMemory('test', 'beta', 'beta content', { tags: ['test'] });
    await store.addMemory('test', 'gamma', 'gamma content', { tags: ['test'] });

    const results = await store.search('alpha OR beta');
    const names = results.map(r => r.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  test('phrase rung ranks adjacent matches above apart matches', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'adjacent', 'token color selector', { tags: ['test'] });
    await store.addMemory('test', 'apart', 'token then some words then color', { tags: ['test'] });

    const results = await store.search('token color');
    expect(results.map(r => r.name)).toContain('adjacent');
    expect(results.map(r => r.name)).toContain('apart');
    expect(results[0]!.name).toBe('adjacent');
  });

  test('all-terms rung wins over partial matches', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'both', 'authentication jwt token', { tags: ['test'] });
    await store.addMemory('test', 'only-auth', 'authentication only', { tags: ['test'] });

    const results = await store.search('authentication jwt');
    const names = results.map(r => r.name);
    expect(names).toContain('both');
    // 'both' matches the strict rungs; the relaxed rung stays quiet.
    expect(results[0]!.name).toBe('both');
    expect(names).not.toContain('only-auth');
  });

  test('any-term rung recovers a multi-word query with only partial terms', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'foundry-token', 'foundry token notes', { tags: ['test'] });
    await store.addMemory('test', 'unrelated', 'nothing relevant here', { tags: ['test'] });

    // 5-term query; only "foundry" and "token" exist (in one memory). The
    // stricter rungs find nothing, so the any-term rung recovers the memory.
    const results = await store.search('foundry token color selector highlight');
    expect(results.map(r => r.name)).toEqual(['foundry-token']);
  });

  test('duplicate hits across rungs deduplicate to one result', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'adjacent', 'token color selector', { tags: ['test'] });

    const results = await store.search('token color');
    expect(results.filter(r => r.name === 'adjacent').length).toBe(1);
  });

  test('NOT excludes matching memories', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth-only', 'authentication token', { tags: ['test'] });
    await store.addMemory('test', 'auth-jwt', 'authentication jwt token', { tags: ['test'] });

    const results = await store.search('authentication NOT jwt');
    const names = results.map(r => r.name);
    expect(names).toContain('auth-only');
    expect(names).not.toContain('auth-jwt');
  });

  test('trailing prefix wildcard expands a term', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'typed', 'typewriter typography', { tags: ['test'] });
    await store.addMemory('test', 'other', 'unrelated content', { tags: ['test'] });

    const results = await store.search('type*');
    expect(results.map(r => r.name)).toEqual(['typed']);
  });

  test('single-term results are unchanged (parity)', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth-flow', 'JWT authentication with refresh tokens', {
      tags: ['test'],
    });
    await store.addMemory('test', 'db-schema', 'PostgreSQL with Prisma ORM', { tags: ['test'] });

    const results = await store.search('authentication');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('auth-flow');
  });

  test('malformed operator input degrades without throwing', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem', 'auth content', { tags: ['test'] });

    const results = await store.search('OR OR auth NOT');
    expect(Array.isArray(results)).toBe(true);
  });

  test('embedded-quote OR query parses and returns results', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'report-endpoint', 'report endpoint project validation', {
      tags: ['test'],
    });

    const results = await store.search('report endpoint project validation OR "005-large-report"');
    expect(results.map(r => r.name)).toContain('report-endpoint');
  });

  test('search ordering is deterministic across repeated runs', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'alpha', 'token color selector', { tags: ['test'] });
    await store.addMemory('test', 'beta', 'token color highlight', { tags: ['test'] });

    const first = (await store.search('token color')).map(r => r.name);
    const second = (await store.search('token color')).map(r => r.name);
    expect(first).toEqual(second);
  });
});

describe('MindStore — Trigram substring sync', () => {
  test('substring channel reflects add/update/delete', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'config-doc', 'configuration settings', {
      tags: ['test'],
    });

    expect((await store.search('iguration')).map(r => r.name)).toEqual(['config-doc']);

    await store.updateMemory(mem.id, { content: 'deployment pipeline' });
    expect(await store.search('iguration')).toEqual([]);
    expect((await store.search('ploymen')).map(r => r.name)).toEqual(['config-doc']);

    store.deleteMemory(mem.id);
    expect(await store.search('ploymen')).toEqual([]);
  });
});

describe('MindStore — Query', () => {
  test('should default queryMemories page size to 25', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);

    for (let i = 0; i < 30; i++) {
      await store.addMemory('test', `mem-${i}`, `content-${i}`, { tags: ['test'] });
    }

    const results = store.queryMemories();
    expect(results.length).toBe(25);
  });

  test('should query memories with metadata filters', async () => {
    store = createTestStore();
    store.createSpace('proj-a', 'Project A', ['test']);
    store.createSpace('proj-b', 'Project B', ['test']);
    await store.addMemory('proj-a', 'auth', 'authentication', { tier: 1, tags: ['backend'] });
    await store.addMemory('proj-a', 'ui', 'frontend', { tier: 2, tags: ['frontend'] });
    await store.addMemory('proj-b', 'api', 'rest', { tier: 1, tags: ['backend'] });

    const results = store.queryMemories({ space: 'proj-a', tier: 1, tag: 'backend' });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('auth');
    expect(results[0]!.space_name).toBe('proj-a');
  });

  test('should support pagination in queryMemories', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem-a', 'a', { tags: ['test'] });
    await store.addMemory('test', 'mem-b', 'b', { tags: ['test'] });
    await store.addMemory('test', 'mem-c', 'c', { tags: ['test'] });

    const page1 = store.queryMemories({ limit: 2, offset: 0 });
    const page2 = store.queryMemories({ limit: 2, offset: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
    expect(page1[0]!.name).not.toBe(page2[0]!.name);
  });

  test('should filter queryMemories by updated_at date bounds', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'mem-a', 'content', { tags: ['test'] });

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const results = store.queryMemories({ from: tomorrow });

    expect(results.length).toBe(0);
  });
});

describe('MindStore — Import', () => {
  test('should import legacy brain.json format', () => {
    store = createTestStore();
    store.importFromJson({
      'my-space': {
        description: 'A space',
        memories: [
          { name: 'mem1', description: 'content 1' },
          { name: 'mem2', description: 'content 2' },
        ],
      },
      'empty-space': {
        description: 'Empty',
        memories: [],
      },
    });

    const spaces = store.listSpaces();
    expect(spaces.length).toBe(2);

    const mem = store.getMemory('my-space', 'mem1');
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe('content 1');
    expect(mem!.tier).toBe(2); // default tier
  });
});

describe('MindStore — RAG Integration', () => {
  test('should calculate cosine similarity correctly', () => {
    const { cosineSimilarity } = require('../src/helpers/rag');

    // Identical vectors should have similarity 1
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1, 5);

    // Orthogonal vectors should have similarity 0
    const v3 = [1, 0, 0];
    const v4 = [0, 1, 0];
    expect(cosineSimilarity(v3, v4)).toBeCloseTo(0, 5);

    // Opposite vectors should have similarity -1
    const v5 = [1, 0, 0];
    const v6 = [-1, 0, 0];
    expect(cosineSimilarity(v5, v6)).toBeCloseTo(-1, 5);

    // Similar vectors should have high positive similarity
    const v7 = [1, 2, 3];
    const v8 = [2, 4, 6];
    expect(cosineSimilarity(v7, v8)).toBeCloseTo(1, 5);
  });

  test('should convert between blob and vector', () => {
    const { vectorToBlob, blobToVector } = require('../src/helpers/rag');

    const original = new Float32Array([1.5, -2.3, 4.7, 0.0]);
    const blob = vectorToBlob(Array.from(original));
    const restored = blobToVector(blob);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  test('should check RAG enabled/disabled from config', () => {
    const { isRagEnabled } = require('../src/helpers/rag');

    // RAG is disabled by default in tests (no env vars)
    expect(isRagEnabled()).toBe(false);
  });
});

describe('MindStore — Logs', () => {
  test('should add a log entry', () => {
    store = createTestStore();
    store.createSpace('test', 'Test space', ['test']);

    store.addLog({
      source: 'cli',
      operation: 'test_operation',
      level: 'info',
      inputData: { arg1: 'value1' },
      outputData: { result: 'success' },
      durationMs: 100,
    });

    const result = store.queryLogs({});
    expect(result.logs.length).toBe(1);
    expect(result.logs[0]!.operation).toBe('test_operation');
    expect(result.logs[0]!.source).toBe('cli');
    expect(result.logs[0]!.level).toBe('info');
    expect(result.logs[0]!.duration_ms).toBe(100);
  });

  test('should query logs with source filter', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'cmd1' });
    store.addLog({ source: 'mcp', operation: 'tool1' });
    store.addLog({ source: 'api', operation: 'route1' });

    const cliLogs = store.queryLogs({ source: 'cli' });
    expect(cliLogs.logs.length).toBe(1);
    expect(cliLogs.logs[0]!.source).toBe('cli');

    const mcpLogs = store.queryLogs({ source: 'mcp' });
    expect(mcpLogs.logs.length).toBe(1);
    expect(mcpLogs.logs[0]!.source).toBe('mcp');
  });

  test('should query logs with multiple sources', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'cmd1' });
    store.addLog({ source: 'mcp', operation: 'tool1' });
    store.addLog({ source: 'api', operation: 'route1' });

    const cliMcpLogs = store.queryLogs({ source: 'cli,mcp' });
    expect(cliMcpLogs.logs.length).toBe(2);
  });

  test('should query logs with operation filter', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'add' });
    store.addLog({ source: 'cli', operation: 'list' });
    store.addLog({ source: 'cli', operation: 'delete' });

    const addLogs = store.queryLogs({ operation: 'add' });
    expect(addLogs.logs.length).toBe(1);
    expect(addLogs.logs[0]!.operation).toBe('add');
  });

  test('should query logs with text search', () => {
    store = createTestStore();

    store.addLog({
      source: 'cli',
      operation: 'memory_add',
      inputData: { space: 'projects/test', name: 'my-memory' },
    });
    store.addLog({
      source: 'cli',
      operation: 'space_create',
      inputData: { name: 'other-space' },
    });

    const searchResult = store.queryLogs({ search: 'memory' });
    expect(searchResult.logs.length).toBe(1);
    expect(searchResult.logs[0]!.operation).toBe('memory_add');
  });

  test('should query logs with level filter', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'info_op', level: 'info' });
    store.addLog({ source: 'cli', operation: 'warn_op', level: 'warn' });
    store.addLog({ source: 'cli', operation: 'error_op', level: 'error' });

    const errorLogs = store.queryLogs({ level: 'error' });
    expect(errorLogs.logs.length).toBe(1);
    expect(errorLogs.logs[0]!.level).toBe('error');
  });

  test('should query logs with pagination', () => {
    store = createTestStore();

    for (let i = 0; i < 25; i++) {
      store.addLog({ source: 'cli', operation: `op_${i}` });
    }

    const page1 = store.queryLogs({ limit: 10, offset: 0 });
    expect(page1.logs.length).toBe(10);
    expect(page1.total).toBe(25);
    expect(page1.limit).toBe(10);
    expect(page1.offset).toBe(0);

    const page2 = store.queryLogs({ limit: 10, offset: 10 });
    expect(page2.logs.length).toBe(10);
    expect(page2.offset).toBe(10);

    const page3 = store.queryLogs({ limit: 10, offset: 20 });
    expect(page3.logs.length).toBe(5);
    expect(page3.offset).toBe(20);
  });

  test('should query logs with order asc/desc', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'first' });
    store.addLog({ source: 'cli', operation: 'second' });
    store.addLog({ source: 'cli', operation: 'third' });

    const desc = store.queryLogs({ order: 'desc' });
    expect(desc.logs[0]!.operation).toBe('third');

    const asc = store.queryLogs({ order: 'asc' });
    expect(asc.logs[0]!.operation).toBe('first');
  });

  test('should truncate log fields to 64KB', () => {
    store = createTestStore();

    // Create input data larger than 64KB
    const largeInput = 'x'.repeat(70000);
    store.addLog({
      source: 'cli',
      operation: 'large_op',
      inputData: { data: largeInput },
    });

    const result = store.queryLogs({});
    expect(result.logs[0]!.input_data!.length).toBe(65536);
  });

  test('should log error entries', () => {
    store = createTestStore();

    store.addLog({
      source: 'api',
      operation: 'failed_op',
      level: 'error',
      errorMessage: 'Something went wrong',
      inputData: { attempt: 1 },
    });

    const result = store.queryLogs({ level: 'error' });
    expect(result.logs.length).toBe(1);
    expect(result.logs[0]!.error_message).toBe('Something went wrong');
  });

  test('should cleanup old logs based on retention', () => {
    store = createTestStore();

    // Add some logs
    store.addLog({ source: 'cli', operation: 'op1' });
    store.addLog({ source: 'cli', operation: 'op2' });
    store.addLog({ source: 'cli', operation: 'op3' });

    let result = store.queryLogs({});
    expect(result.total).toBe(3);

    // Cleanup with -1 minute retention (cutoff is in the future, so all logs get deleted)
    const deleted = store.cleanupOldLogs(-1);
    expect(deleted).toBe(3);

    result = store.queryLogs({});
    expect(result.total).toBe(0);
  });

  test('should return total count in query result', () => {
    store = createTestStore();

    store.addLog({ source: 'cli', operation: 'op1' });
    store.addLog({ source: 'cli', operation: 'op2' });

    const result = store.queryLogs({ limit: 1 });
    expect(result.total).toBe(2);
    expect(result.logs.length).toBe(1);
  });
});
