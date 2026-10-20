import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import {
  buildLinkedMemoriesArray,
  resolveLinkEndpoint,
  type EnrichedLink,
} from '../src/helpers/link-building';
import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createLinkTools } from '../src/mcp/tools/links';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
  setSystemTime();
});

async function seedSpace() {
  store = createTestStore();
  store.createSpace('proj', 'Project', ['test']);
}

describe('resolveLinkEndpoint', () => {
  test('resolves the outgoing endpoint', () => {
    expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'a')).toEqual({
      id: 'b',
      direction: 'outgoing',
    });
  });

  test('resolves the incoming endpoint', () => {
    expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'b')).toEqual({
      id: 'a',
      direction: 'incoming',
    });
  });

  test('returns null for self links and unknown memories', () => {
    expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'c')).toBeNull();
    expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'a' }, 'a')).toBeNull();
  });
});

describe('memory_read link metadata', () => {
  test('outgoing links expose the stored label and outgoing direction', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'decision-a', 'A', { tags: ['cat:decision'] });
    const b = await store.addMemory('proj', 'bugfix-b', 'B', { tags: ['cat:bugfix'] });
    store.link(a.id, b.id, 'caused_by');

    const res = await createMemoryTools(store).memory_read.handler({
      space: 'proj',
      name: 'decision-a',
      noPromote: true,
    });

    expect(res.links_to).toHaveLength(1);
    expect(res.links_to[0]?.label).toBe('caused_by');
    expect(res.links_to[0]?.direction).toBe('outgoing');
    expect(res.linked_by).toHaveLength(0);
  });

  test('incoming links expose the stored label and incoming direction', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'decision-a', 'A', { tags: ['cat:decision'] });
    const b = await store.addMemory('proj', 'bugfix-b', 'B', { tags: ['cat:bugfix'] });
    store.link(a.id, b.id, 'caused_by');

    const res = await createMemoryTools(store).memory_read.handler({
      space: 'proj',
      name: 'bugfix-b',
      noPromote: true,
    });

    expect(res.links_to).toHaveLength(0);
    expect(res.linked_by).toHaveLength(1);
    expect(res.linked_by[0]?.label).toBe('caused_by');
    expect(res.linked_by[0]?.direction).toBe('incoming');
  });

  test('bidirectional pairs keep distinct labels and directions', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'a', 'A', { tags: ['test'] });
    const b = await store.addMemory('proj', 'b', 'B', { tags: ['test'] });
    store.link(a.id, b.id, 'implements');
    store.link(b.id, a.id, 'contradicts');

    const res = await createMemoryTools(store).memory_read.handler({
      space: 'proj',
      name: 'a',
      noPromote: true,
    });

    expect(res.links_to).toHaveLength(1);
    expect(res.links_to[0]?.label).toBe('implements');
    expect(res.links_to[0]?.direction).toBe('outgoing');
    expect(res.linked_by).toHaveLength(1);
    expect(res.linked_by[0]?.label).toBe('contradicts');
    expect(res.linked_by[0]?.direction).toBe('incoming');
  });
});

describe('checkpoint linked memories', () => {
  test('an incoming link does not make the checkpoint include itself', async () => {
    await seedSpace();
    const checkpointTools = createCheckpointTools(store);
    const incoming = await store.addMemory('proj', 'incoming-memory', 'Incoming', {
      tags: ['test'],
    });
    const outgoing = await store.addMemory('proj', 'outgoing-memory', 'Outgoing', {
      tags: ['test'],
    });

    const saved = await checkpointTools.checkpoint_save.handler({
      space: 'proj',
      goal: 'Goal',
      linked_memories: ['outgoing-memory'],
    });
    const checkpointName = saved.checkpoint!.name;
    const checkpointMemory = store.getMemory('proj', checkpointName)!;

    // An incoming relation pointing at the checkpoint used to resolve to the
    // checkpoint itself and consume a slot in linked_memories.
    store.link(incoming.id, checkpointMemory.id, 'references');

    const loaded = await checkpointTools.checkpoint_load.handler({
      space: 'proj',
      checkpointName,
    });

    const names = loaded.checkpoint?.linked_memories.map((link: EnrichedLink) => link.name) ?? [];
    expect(names).not.toContain(checkpointName);
    expect(names).toContain('outgoing-memory');
    expect(names).toContain('incoming-memory');

    const outgoingLink = loaded.checkpoint?.linked_memories.find(
      (link: EnrichedLink) => link.name === 'outgoing-memory'
    );
    expect(outgoingLink?.direction).toBe('outgoing');
    expect(outgoingLink?.label).toBe('related');

    const incomingLink = loaded.checkpoint?.linked_memories.find(
      (link: EnrichedLink) => link.name === 'incoming-memory'
    );
    expect(incomingLink?.direction).toBe('incoming');
    expect(incomingLink?.label).toBe('references');

    void incoming;
    void outgoing;
  });

  test('incoming links do not starve outgoing links when a limit applies', async () => {
    await seedSpace();
    for (const name of ['out-1', 'out-2', 'out-3']) {
      await store.addMemory('proj', name, name, { tags: ['test'] });
    }

    const checkpointTools = createCheckpointTools(store);
    const saved = await checkpointTools.checkpoint_save.handler({
      space: 'proj',
      goal: 'Goal',
      linked_memories: ['out-1', 'out-2', 'out-3'],
    });
    const checkpointMemory = store.getMemory('proj', saved.checkpoint!.name)!;

    // Outgoing relations exist first; newer incoming relations must not
    // consume the limit before outgoing relations are considered.
    for (const name of ['in-1', 'in-2', 'in-3']) {
      const source = await store.addMemory('proj', name, name, { tags: ['test'] });
      store.link(source.id, checkpointMemory.id, 'references');
    }

    const linked = buildLinkedMemoriesArray(store, checkpointMemory.id, 2);

    expect(linked).toHaveLength(2);
    expect(linked.every(link => link.direction === 'outgoing')).toBe(true);
  });
});

describe('link_create relabeling and link_delete idempotency', () => {
  test('memory_add.links_to stores the generic related label', async () => {
    await seedSpace();
    const target = await store.addMemory('proj', 'target-memory', 'Target', { tags: ['test'] });
    const tools = createMemoryTools(store);

    const response = await tools.memory_add.handler({
      space: 'proj',
      name: 'source-memory',
      content: 'Source',
      tags: ['test'],
      links_to: ['proj:target-memory'],
    });

    expect(response.links_created).toEqual([
      { source: 'source-memory', target: 'target-memory', label: 'related' },
    ]);
    expect(response.links_failed).toEqual([]);

    const source = store.getMemory('proj', 'source-memory')!;
    const links = store.getLinks(source.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe('related');
    expect(links[0]?.source_id).toBe(source.id);
    expect(links[0]?.target_id).toBe(target.id);
  });

  test('re-creating the same directed pair replaces the label and keeps one link', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'a', 'A', { tags: ['test'] });
    const b = await store.addMemory('proj', 'b', 'B', { tags: ['test'] });
    const tools = createLinkTools(store);

    await tools.link_create.handler({ sourceRef: 'proj:a', targetRef: 'proj:b', label: 'related' });
    await tools.link_create.handler({
      sourceRef: 'proj:a',
      targetRef: 'proj:b',
      label: 'implements',
    });

    const links = store.getLinks(a.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe('implements');
    expect(links[0]?.source_id).toBe(a.id);
    expect(links[0]?.target_id).toBe(b.id);
  });

  test('deleting a missing link succeeds and creates nothing', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'a', 'A', { tags: ['test'] });
    await store.addMemory('proj', 'b', 'B', { tags: ['test'] });
    const tools = createLinkTools(store);

    await expect(
      tools.link_delete.handler({ sourceRef: 'proj:a', targetRef: 'proj:b' })
    ).resolves.toBeDefined();

    expect(store.getLinks(a.id)).toHaveLength(0);
  });
});

describe('link retrieval integrity', () => {
  test('orders links deterministically when timestamps are equal', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'a', 'A', { tags: ['test'] });
    const b = await store.addMemory('proj', 'b', 'B', { tags: ['test'] });
    const c = await store.addMemory('proj', 'c', 'C', { tags: ['test'] });

    setSystemTime(new Date('2026-05-01T00:00:00Z'));
    store.link(a.id, b.id, 'first');
    store.link(a.id, c.id, 'second');

    const firstRead = store.getLinks(a.id).map(link => link.target_name);
    const secondRead = store.getLinks(a.id).map(link => link.target_name);

    expect(firstRead).toEqual(['c', 'b']);
    expect(secondRead).toEqual(firstRead);
  });

  test('deleting a memory cascades its links', async () => {
    await seedSpace();
    const a = await store.addMemory('proj', 'a', 'A', { tags: ['test'] });
    const b = await store.addMemory('proj', 'b', 'B', { tags: ['test'] });
    store.link(a.id, b.id, 'related');

    store.deleteMemory(a.id);

    expect(store.getLinks(b.id)).toHaveLength(0);
  });
});
