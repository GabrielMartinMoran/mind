import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

beforeEach(() => {
  store = createTestStore();
  store.createSpace('projects/demo', 'Demo project', ['type:project']);
});

afterEach(() => {
  store?.cleanup();
});

function readCheckpointContent(space: string, name: string) {
  const memory = store.getMemory(space, name);
  expect(memory).not.toBeNull();
  return JSON.parse(memory!.content);
}

async function createCheckpoint(
  tools: ReturnType<typeof createCheckpointTools>,
  args: Record<string, unknown>
) {
  const result = await tools.checkpoint_save.handler({
    space: 'projects/demo',
    ...args,
  });
  return result.checkpoint!;
}

describe('checkpoint_save partial updates', () => {
  test('omitted fields preserve existing values and identity', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Ship D1',
      pending: 'Write tests',
      notes: 'Original note',
    });
    const before = store.getMemory('projects/demo', created.name)!;

    const result = await tools.checkpoint_save.handler({
      space: 'projects/demo',
      notes: 'Updated note',
    });

    expect(result.checkpoint?.name).toBe(created.name);
    expect(result.checkpoint?.tags).toContain('checkpoint');
    expect(result.checkpoint?.tags).toContain('active');
    expect(result.checkpoint?.tier).toBe(1);

    const after = store.getMemory('projects/demo', created.name)!;
    const content = JSON.parse(after.content);
    expect(content.goal).toBe('Ship D1');
    expect(content.pending).toBe('Write tests');
    expect(content.notes).toBe('Updated note');
    expect(content.createdAt).toBe(JSON.parse(before.content).createdAt);
    expect(after.created_at).toBe(before.created_at);
  });

  test('an explicit empty string clears only that field', async () => {
    const tools = createCheckpointTools(store);
    await createCheckpoint(tools, {
      goal: 'Goal stays',
      pending: 'Pending to clear',
      notes: 'Notes stay',
    });

    await tools.checkpoint_save.handler({
      space: 'projects/demo',
      pending: '',
    });

    const checkpoints = store.listMemories('projects/demo', { tag: 'checkpoint' });
    const content = readCheckpointContent('projects/demo', checkpoints[0]!.name);
    expect(content.pending).toBe('');
    expect(content.goal).toBe('Goal stays');
    expect(content.notes).toBe('Notes stay');
  });

  test('a no-op save returns the checkpoint without advancing updated_at', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Stable goal',
      pending: 'Stable pending',
      notes: 'Stable notes',
    });
    const before = store.getMemory('projects/demo', created.name)!;

    // SQLite timestamps have second resolution, so cross a second boundary to
    // make an accidental rewrite visible.
    await Bun.sleep(1_100);

    const result = await tools.checkpoint_save.handler({
      space: 'projects/demo',
    });

    const after = store.getMemory('projects/demo', created.name)!;
    expect(result.checkpoint?.name).toBe(created.name);
    expect(after.content).toBe(before.content);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.changed_at).toBe(before.changed_at);
  });

  test('an explicit identical value is not a change', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, { goal: 'Same goal' });
    const before = store.getMemory('projects/demo', created.name)!;

    await Bun.sleep(1_100);
    await tools.checkpoint_save.handler({ space: 'projects/demo', goal: 'Same goal' });

    const after = store.getMemory('projects/demo', created.name)!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  test('a new checkpoint applies defaults for omitted fields', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, { goal: 'Only a goal' });

    expect(created.name.startsWith('checkpoint-')).toBe(true);
    expect(created.tags).toContain('checkpoint');
    expect(created.tags).toContain('active');
    expect(created.tier).toBe(1);

    const content = readCheckpointContent('projects/demo', created.name);
    expect(content.goal).toBe('Only a goal');
    expect(content.pending).toBe('');
    expect(content.notes).toBe('');
    expect(typeof content.createdAt).toBe('string');
    expect(typeof content.updatedAt).toBe('string');
  });

  test('a T3 active checkpoint is found and updated instead of duplicated', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Promoted down',
      pending: 'Keep me',
    });
    const checkpoint = store.getMemory('projects/demo', created.name)!;

    store.demote(checkpoint.id);
    store.demote(checkpoint.id);
    expect(store.getMemoryById(checkpoint.id)!.tier).toBe(3);

    const result = await tools.checkpoint_save.handler({
      space: 'projects/demo',
      goal: 'Updated at T3',
    });

    expect(result.checkpoint?.name).toBe(created.name);
    expect(result.checkpoint?.tier).toBe(3);

    const t1t2 = store.listMemories('projects/demo', { tag: 'checkpoint' });
    const t3 = store.listMemories('projects/demo', { tag: 'checkpoint', tier: 3 });
    const all = [...t1t2, ...t3];
    expect(all.filter(memory => memory.tags.includes('active'))).toHaveLength(1);

    const content = readCheckpointContent('projects/demo', created.name);
    expect(content.goal).toBe('Updated at T3');
    expect(content.pending).toBe('Keep me');
  });

  test('corrupt existing content returns an error and is not overwritten', async () => {
    const tools = createCheckpointTools(store);
    const corrupt = await store.addMemory('projects/demo', 'checkpoint-corrupt', 'not-json', {
      tags: ['checkpoint', 'active'],
      tier: 1,
    });

    await expect(
      tools.checkpoint_save.handler({ space: 'projects/demo', goal: 'New goal' })
    ).rejects.toThrow(/invalid json|corrupt/i);

    expect(store.getMemoryById(corrupt.id)!.content).toBe('not-json');
  });
});

describe('checkpoint_save linked memories', () => {
  test('links are additive, [] preserves them, and invalid refs are reported', async () => {
    const tools = createCheckpointTools(store);
    const first = await store.addMemory('projects/demo', 'first', 'First', { tags: ['test'] });
    const second = await store.addMemory('projects/demo', 'second', 'Second', { tags: ['test'] });

    const created = await createCheckpoint(tools, {
      goal: 'Link test',
      linked_memories: ['first'],
    });

    const result = await tools.checkpoint_save.handler({
      space: 'projects/demo',
      linked_memories: ['second', 'missing-memory'],
    });

    const checkpoint = store.getMemory('projects/demo', created.name)!;
    const links = store.getLinks(checkpoint.id).filter(link => link.source_id === checkpoint.id);
    const targets = links.map(link => link.target_id).sort();
    expect(targets).toEqual([first.id, second.id].sort());
    expect(result.links_created).toEqual([
      { source: created.name, target: 'second', label: 'related' },
    ]);
    expect(result.links_failed).toHaveLength(1);
    expect(result.links_failed?.[0]?.ref).toBe('missing-memory');

    const afterEmpty = await tools.checkpoint_save.handler({
      space: 'projects/demo',
      linked_memories: [],
    });
    expect(afterEmpty.links_created).toEqual([]);
    expect(afterEmpty.links_failed).toEqual([]);

    const linksAfterEmpty = store
      .getLinks(checkpoint.id)
      .filter(link => link.source_id === checkpoint.id);
    expect(linksAfterEmpty).toHaveLength(2);
  });

  test('re-adding a directed pair does not downgrade a specific label', async () => {
    const tools = createCheckpointTools(store);
    const target = await store.addMemory('projects/demo', 'decision', 'Decision', {
      tags: ['cat:decision'],
    });
    const created = await createCheckpoint(tools, { goal: 'Label test' });
    const checkpoint = store.getMemory('projects/demo', created.name)!;

    store.link(checkpoint.id, target.id, 'implements');

    await tools.checkpoint_save.handler({
      space: 'projects/demo',
      linked_memories: ['decision'],
    });

    const links = store
      .getLinks(checkpoint.id)
      .filter(link => link.source_id === checkpoint.id && link.target_id === target.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe('implements');
  });
});
