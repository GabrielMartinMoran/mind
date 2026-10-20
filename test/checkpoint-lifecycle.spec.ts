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

function sessionMemories() {
  return store.queryMemories({ space: 'projects/demo', tag: 'type:session' });
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

describe('checkpoint_done lifecycle', () => {
  test('rejects a checkpoint with pending work and leaves it intact', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Incomplete task',
      pending: 'Write the remaining tests',
    });

    await expect(
      tools.checkpoint_done.handler({
        space: 'projects/demo',
        checkpointName: created.name,
        summary: 'Tried to finish early',
      })
    ).rejects.toThrow(/pending/i);

    const checkpoint = store.getMemory('projects/demo', created.name);
    expect(checkpoint).not.toBeNull();
    expect(sessionMemories()).toHaveLength(0);
  });

  test('treats whitespace-only pending as empty', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Whitespace pending',
      pending: '   ',
    });

    const result = await tools.checkpoint_done.handler({
      space: 'projects/demo',
      checkpointName: created.name,
      summary: 'Completed',
    });

    expect(result.session_memory).toBeDefined();
    expect(store.getMemory('projects/demo', created.name)).toBeNull();
  });

  test('completes a checkpoint into a T3 session summary and deletes it', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, {
      goal: 'Finish feature',
      pending: '',
      notes: 'Important context',
    });

    const result = await tools.checkpoint_done.handler({
      space: 'projects/demo',
      checkpointName: created.name,
      summary: 'Feature finished and verified',
    });

    const session = store.getMemory('projects/demo', result.session_memory!.name)!;
    expect(session.tier).toBe(3);
    expect(session.tags).toContain('type:session');
    expect(session.tags).toContain('cat:summary');

    const content = JSON.parse(session.content);
    expect(content.whatWasDone).toBe('Feature finished and verified');
    expect(content.goal).toBe('Finish feature');
    expect(content.pending).toBe('');
    expect(content.notes).toBe('Important context');
    expect(content.originalCheckpoint).toBe(created.name);
    expect(content.sessionSummary.schema).toBe('mind.session-summary/v1');
    expect(content.sessionSummary.writer.id).toBe('checkpoint_done');

    expect(store.getMemory('projects/demo', created.name)).toBeNull();
  });

  test('rejects a memory that is not tagged as a checkpoint', async () => {
    const tools = createCheckpointTools(store);
    const impostor = await store.addMemory(
      'projects/demo',
      'looks-like-checkpoint',
      JSON.stringify({ goal: 'Fake', pending: '', notes: '' }),
      { tags: ['type:session', 'cat:summary'], tier: 3 }
    );

    await expect(
      tools.checkpoint_done.handler({
        space: 'projects/demo',
        checkpointName: impostor.name,
        summary: 'Should not transform',
      })
    ).rejects.toThrow(/not a checkpoint/i);

    const unchanged = store.getMemoryById(impostor.id)!;
    expect(unchanged.content).toBe(impostor.content);
    expect(unchanged.tags).toContain('type:session');
    expect(unchanged.tags).toContain('cat:summary');
    expect(unchanged.tags).not.toContain('checkpoint');
    expect(sessionMemories()).toHaveLength(1);
  });

  test('preserves inbound and outbound links with their labels', async () => {
    const tools = createCheckpointTools(store);
    const outgoingTarget = await store.addMemory('projects/demo', 'outgoing-target', 'Out', {
      tags: ['test'],
    });
    const incomingSource = await store.addMemory('projects/demo', 'incoming-source', 'In', {
      tags: ['test'],
    });

    const created = await createCheckpoint(tools, {
      goal: 'Link preservation',
      linked_memories: ['outgoing-target'],
    });
    const checkpoint = store.getMemory('projects/demo', created.name)!;
    store.link(incomingSource.id, checkpoint.id, 'references');

    const result = await tools.checkpoint_done.handler({
      space: 'projects/demo',
      checkpointName: created.name,
      summary: 'Done',
    });
    const session = store.getMemory('projects/demo', result.session_memory!.name)!;
    const links = store.getLinks(session.id);

    const outgoing = links.find(
      link => link.source_id === session.id && link.target_id === outgoingTarget.id
    );
    expect(outgoing?.label).toBe('related');

    const incoming = links.find(
      link => link.source_id === incomingSource.id && link.target_id === session.id
    );
    expect(incoming?.label).toBe('references');

    expect(store.getMemory('projects/demo', created.name)).toBeNull();
  });

  test('a second done call fails because no active checkpoint remains', async () => {
    const tools = createCheckpointTools(store);
    const created = await createCheckpoint(tools, { goal: 'Only once', pending: '' });

    await tools.checkpoint_done.handler({
      space: 'projects/demo',
      checkpointName: created.name,
      summary: 'Done',
    });

    await expect(
      tools.checkpoint_done.handler({
        space: 'projects/demo',
        summary: 'Again',
      })
    ).rejects.toThrow(/no active checkpoint/i);

    expect(sessionMemories()).toHaveLength(1);
  });
});
