import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

const SPACE = 'projects/demo';

let store: MindStore & { cleanup: () => void };
let injector: Database | null;

beforeEach(() => {
  store = createTestStore();
  store.createSpace(SPACE, 'Demo project', ['type:project']);
  injector = null;
});

afterEach(() => {
  injector?.close();
  injector = null;
  store?.cleanup();
});

interface CheckpointFixture {
  tools: ReturnType<typeof createCheckpointTools>;
  checkpointId: string;
  checkpointName: string;
  outbound: string;
  inbound: string;
}

/**
 * Seed a completed checkpoint with one outbound link (checkpoint → outbound)
 * and one inbound link (inbound → checkpoint) carrying distinct labels.
 */
async function seedCheckpointWithLinks(): Promise<CheckpointFixture> {
  const tools = createCheckpointTools(store);
  const outbound = await store.addMemory(SPACE, 'outbound-target', 'Outbound body', {
    tags: ['test'],
  });
  const inbound = await store.addMemory(SPACE, 'inbound-source', 'Inbound body', {
    tags: ['test'],
  });

  const saved = await tools.checkpoint_save.handler({
    space: SPACE,
    goal: 'Atomic completion',
    pending: '',
    notes: 'Atomicity fixture',
    linked_memories: ['outbound-target'],
  });

  const checkpoint = store.getMemory(SPACE, saved.checkpoint!.name)!;
  store.link(inbound.id, checkpoint.id, 'references');

  return {
    tools,
    checkpointId: checkpoint.id,
    checkpointName: checkpoint.name,
    outbound: outbound.id,
    inbound: inbound.id,
  };
}

/** Relations of a memory as stable "source->target:label" strings. */
function relationsOf(memoryId: string): string[] {
  return store
    .getLinks(memoryId)
    .map(link => `${link.source_id}->${link.target_id}:${link.label}`)
    .sort();
}

function openInjector(): Database {
  injector = new Database(store.getStatus().db_path);
  injector.exec('PRAGMA busy_timeout=5000');
  return injector;
}

function sessionSummaries() {
  return store.queryMemories({ space: SPACE, tag: 'type:session' });
}

describe('checkpoint completion atomicity', () => {
  test('summary insert failure rolls back and the completion can be retried', async () => {
    const fixture = await seedCheckpointWithLinks();
    const originalLinks = relationsOf(fixture.checkpointId);

    openInjector().exec(`
      CREATE TRIGGER fail_summary_insert
      BEFORE INSERT ON memories
      WHEN NEW.name LIKE 'session-%'
      BEGIN
        SELECT RAISE(ABORT, 'injected summary failure');
      END;
    `);

    await expect(
      fixture.tools.checkpoint_done.handler({
        space: SPACE,
        checkpointName: fixture.checkpointName,
        summary: 'Should roll back',
      })
    ).rejects.toThrow(/injected summary failure/);

    expect(store.getMemory(SPACE, fixture.checkpointName)).not.toBeNull();
    expect(sessionSummaries()).toHaveLength(0);
    expect(relationsOf(fixture.checkpointId)).toEqual(originalLinks);

    injector!.exec('DROP TRIGGER fail_summary_insert');

    const result = await fixture.tools.checkpoint_done.handler({
      space: SPACE,
      checkpointName: fixture.checkpointName,
      summary: 'Retried successfully',
    });

    expect(result.session_memory).toBeDefined();
    expect(sessionSummaries()).toHaveLength(1);
    expect(store.getMemory(SPACE, fixture.checkpointName)).toBeNull();
  });

  test('link copy failure rolls back the summary and copied links', async () => {
    const fixture = await seedCheckpointWithLinks();
    const originalLinks = relationsOf(fixture.checkpointId);

    openInjector().exec(`
      CREATE TRIGGER fail_link_insert
      BEFORE INSERT ON links
      BEGIN
        SELECT RAISE(ABORT, 'injected link failure');
      END;
    `);

    await expect(
      fixture.tools.checkpoint_done.handler({
        space: SPACE,
        checkpointName: fixture.checkpointName,
        summary: 'Should roll back',
      })
    ).rejects.toThrow(/injected link failure/);

    expect(store.getMemory(SPACE, fixture.checkpointName)).not.toBeNull();
    expect(sessionSummaries()).toHaveLength(0);
    expect(relationsOf(fixture.checkpointId)).toEqual(originalLinks);

    injector!.exec('DROP TRIGGER fail_link_insert');

    const result = await fixture.tools.checkpoint_done.handler({
      space: SPACE,
      checkpointName: fixture.checkpointName,
      summary: 'Retried successfully',
    });

    const summary = store.getMemory(SPACE, result.session_memory!.name)!;
    expect(sessionSummaries()).toHaveLength(1);
    expect(store.getMemory(SPACE, fixture.checkpointName)).toBeNull();
    expect(relationsOf(summary.id)).toEqual(
      [
        `${fixture.inbound}->${summary.id}:references`,
        `${summary.id}->${fixture.outbound}:related`,
      ].sort()
    );
  });

  test('checkpoint deletion failure rolls back the summary and copied links', async () => {
    const fixture = await seedCheckpointWithLinks();
    const originalLinks = relationsOf(fixture.checkpointId);

    openInjector().exec(`
      CREATE TRIGGER fail_checkpoint_delete
      BEFORE DELETE ON memories
      WHEN OLD.name LIKE 'checkpoint-%'
      BEGIN
        SELECT RAISE(ABORT, 'injected delete failure');
      END;
    `);

    await expect(
      fixture.tools.checkpoint_done.handler({
        space: SPACE,
        checkpointName: fixture.checkpointName,
        summary: 'Should roll back',
      })
    ).rejects.toThrow(/injected delete failure/);

    expect(store.getMemory(SPACE, fixture.checkpointName)).not.toBeNull();
    expect(sessionSummaries()).toHaveLength(0);
    expect(relationsOf(fixture.checkpointId)).toEqual(originalLinks);

    injector!.exec('DROP TRIGGER fail_checkpoint_delete');

    const result = await fixture.tools.checkpoint_done.handler({
      space: SPACE,
      checkpointName: fixture.checkpointName,
      summary: 'Retried successfully',
    });

    expect(result.session_memory).toBeDefined();
    expect(sessionSummaries()).toHaveLength(1);
    expect(store.getMemory(SPACE, fixture.checkpointName)).toBeNull();
  });

  test('successful completion preserves tier, tags, content, and both link directions', async () => {
    const fixture = await seedCheckpointWithLinks();

    const result = await fixture.tools.checkpoint_done.handler({
      space: SPACE,
      checkpointName: fixture.checkpointName,
      summary: 'All done atomically',
    });

    const summary = store.getMemory(SPACE, result.session_memory!.name)!;
    expect(summary.tier).toBe(3);
    expect(summary.tags).toContain('type:session');
    expect(summary.tags).toContain('cat:summary');
    expect(summary.name.startsWith('session-')).toBe(true);

    const content = JSON.parse(summary.content);
    expect(content.whatWasDone).toBe('All done atomically');
    expect(content.originalCheckpoint).toBe(fixture.checkpointName);
    expect(content.sessionSummary.schema).toBe('mind.session-summary/v1');

    expect(relationsOf(summary.id)).toEqual(
      [
        `${fixture.inbound}->${summary.id}:references`,
        `${summary.id}->${fixture.outbound}:related`,
      ].sort()
    );

    expect(sessionSummaries()).toHaveLength(1);
    expect(store.getMemory(SPACE, fixture.checkpointName)).toBeNull();
    expect(store.getLinks(fixture.checkpointId)).toHaveLength(0);
  });
});
