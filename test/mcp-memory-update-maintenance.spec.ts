import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { computeTagDiff } from '../src/mcp/handlers/memories/update-memory';
import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createLinkTools } from '../src/mcp/tools/links';
import { createMemoryTools } from '../src/mcp/tools/memories';
import { createSpaceTools } from '../src/mcp/tools/spaces';
import { createStatusTools } from '../src/mcp/tools/status';
import { createSystemTools } from '../src/mcp/tools/system';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

beforeEach(() => {
  store = createTestStore();
  store.createSpace('test-space', 'Test space', ['test']);
});

afterEach(() => {
  store?.cleanup();
});

async function addMemory(
  name: string,
  opts: { tier?: 1 | 2 | 3; pinned?: boolean; content?: string; tags?: string[] } = {}
) {
  await store.addMemory('test-space', name, opts.content ?? `${name} content`, {
    tier: opts.tier ?? 2,
    pinned: opts.pinned,
    tags: opts.tags ?? ['cat:decision'],
  });
  return store.getMemory('test-space', name)!;
}

function expectYamlParity(response: {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}) {
  expect(response.content).toHaveLength(1);
  expect(response.structuredContent).toBeDefined();
  expect(parseYaml(response.content[0]!.text)).toEqual(response.structuredContent);
}

describe('computeTagDiff (pure)', () => {
  test('normalizes and dedupes proposed tags, then diffs against existing tags', () => {
    expect(
      computeTagDiff(['cat:decision', 'old:tag'], ['#Cat:Decision', 'New:Tag', 'new:tag'])
    ).toEqual({
      addTags: ['new:tag'],
      removeTags: ['old:tag'],
    });
  });

  test('returns an empty diff when the sets are equal', () => {
    expect(computeTagDiff(['a', 'b'], ['b', 'a'])).toEqual({ addTags: [], removeTags: [] });
  });

  test('rejects invalid proposed tags', () => {
    expect(() => computeTagDiff(['a'], ['has space'])).toThrow('invalid characters');
  });
});

describe('memory_update maintenance and atomicity', () => {
  test('pins then unpins a memory and reports pinned in the response', async () => {
    await addMemory('m');
    const tools = createMemoryTools(store);

    const pinned = await tools.memory_update.handler({
      space: 'test-space',
      name: 'm',
      pinned: true,
    });
    expect(pinned.memory?.pinned).toBe(true);
    expect(store.getMemory('test-space', 'm')?.pinned).toBe(true);

    const unpinned = await tools.memory_update.handler({
      space: 'test-space',
      name: 'm',
      pinned: false,
    });
    expect(unpinned.memory?.pinned).toBe(false);
    expect(store.getMemory('test-space', 'm')?.pinned).toBe(false);
  });

  test('promotes T2→T1 and T3→T2', async () => {
    await addMemory('t2', { tier: 2 });
    await addMemory('t3', { tier: 3 });
    const tools = createMemoryTools(store);

    const twoToOne = await tools.memory_update.handler({
      space: 'test-space',
      name: 't2',
      tierTransition: 'promote',
    });
    expect(twoToOne.memory?.tier).toBe(1);

    const threeToTwo = await tools.memory_update.handler({
      space: 'test-space',
      name: 't3',
      tierTransition: 'promote',
    });
    expect(threeToTwo.memory?.tier).toBe(2);
    expect(store.getMemory('test-space', 't2')?.tier).toBe(1);
    expect(store.getMemory('test-space', 't3')?.tier).toBe(2);
  });

  test('demotes T1→T2 and T2→T3', async () => {
    await addMemory('t1', { tier: 1 });
    await addMemory('t2', { tier: 2 });
    const tools = createMemoryTools(store);

    const oneToTwo = await tools.memory_update.handler({
      space: 'test-space',
      name: 't1',
      tierTransition: 'demote',
    });
    expect(oneToTwo.memory?.tier).toBe(2);

    const twoToThree = await tools.memory_update.handler({
      space: 'test-space',
      name: 't2',
      tierTransition: 'demote',
    });
    expect(twoToThree.memory?.tier).toBe(3);
    expect(store.getMemory('test-space', 't1')?.tier).toBe(2);
    expect(store.getMemory('test-space', 't2')?.tier).toBe(3);
  });

  test('promote at T1 fails and leaves content unchanged', async () => {
    const original = await addMemory('top', { tier: 1, content: 'original' });
    const tools = createMemoryTools(store);

    await expect(
      tools.memory_update.handler({
        space: 'test-space',
        name: 'top',
        content: 'should not persist',
        tierTransition: 'promote',
      })
    ).rejects.toThrow(/already at T1|highest tier/i);

    const after = store.getMemory('test-space', 'top')!;
    expect(after.content).toBe('original');
    expect(after.tier).toBe(1);
    expect(after.changed_at).toBe(original.changed_at);
  });

  test('demote at T3 fails and leaves content unchanged', async () => {
    const original = await addMemory('bottom', { tier: 3, content: 'original' });
    const tools = createMemoryTools(store);

    await expect(
      tools.memory_update.handler({
        space: 'test-space',
        name: 'bottom',
        content: 'should not persist',
        tierTransition: 'demote',
      })
    ).rejects.toThrow(/lowest tier/i);

    const after = store.getMemory('test-space', 'bottom')!;
    expect(after.content).toBe('original');
    expect(after.tier).toBe(3);
    expect(after.changed_at).toBe(original.changed_at);
  });

  test('combined content+promote rolls back when T1 is full and all pinned', async () => {
    for (let i = 0; i < 25; i++) {
      await addMemory(`hot-${i}`, { tier: 1, pinned: true });
    }
    const original = await addMemory('warm', { tier: 2, content: 'original' });
    const tools = createMemoryTools(store);

    await expect(
      tools.memory_update.handler({
        space: 'test-space',
        name: 'warm',
        content: 'should not persist',
        tierTransition: 'promote',
      })
    ).rejects.toThrow(/T1 is full/i);

    const after = store.getMemory('test-space', 'warm')!;
    expect(after.content).toBe('original');
    expect(after.tier).toBe(2);
    expect(after.changed_at).toBe(original.changed_at);
  });

  test('an invalid tag aborts before any content update', async () => {
    const original = await addMemory('m', { content: 'original' });
    const tools = createMemoryTools(store);

    await expect(
      tools.memory_update.handler({
        space: 'test-space',
        name: 'm',
        content: 'should not persist',
        tags: ['not valid'],
      })
    ).rejects.toThrow('invalid characters');

    const after = store.getMemory('test-space', 'm')!;
    expect(after.content).toBe('original');
    expect(after.tags).toEqual(original.tags);
    expect(after.changed_at).toBe(original.changed_at);
  });

  test('tags keep replace semantics and preserve the exact new set', async () => {
    await addMemory('m', { tags: ['cat:decision', 'old:tag'] });
    const tools = createMemoryTools(store);

    const res = await tools.memory_update.handler({
      space: 'test-space',
      name: 'm',
      tags: ['#New:Tag', 'cat:bugfix'],
    });

    expect(res.memory?.tags?.slice().sort()).toEqual(['cat:bugfix', 'new:tag']);
    expect(store.getMemory('test-space', 'm')?.tags.slice().sort()).toEqual([
      'cat:bugfix',
      'new:tag',
    ]);
  });

  test('an empty update is a no-op', async () => {
    const original = await addMemory('m', { content: 'original' });
    const tools = createMemoryTools(store);

    const res = await tools.memory_update.handler({ space: 'test-space', name: 'm' });

    expect(res.memory?.content).toBe('original');
    expect(res.memory?.tags).toEqual(original.tags);
    expect(store.getMemory('test-space', 'm')?.changed_at).toBe(original.changed_at);
  });

  test('a pinned memory is moved by an explicit promotion and stays pinned', async () => {
    await addMemory('pinned-warm', { tier: 2, pinned: true });
    const tools = createMemoryTools(store);

    const res = await tools.memory_update.handler({
      space: 'test-space',
      name: 'pinned-warm',
      tierTransition: 'promote',
    });

    expect(res.memory?.tier).toBe(1);
    expect(res.memory?.pinned).toBe(true);
    expect(store.getMemory('test-space', 'pinned-warm')?.tier).toBe(1);
    expect(store.getMemory('test-space', 'pinned-warm')?.pinned).toBe(true);
  });

  test('existing content/newName/tags calls keep working', async () => {
    await addMemory('m', { tags: ['cat:decision'] });
    const tools = createMemoryTools(store);

    await tools.memory_update.handler({
      space: 'test-space',
      name: 'm',
      newName: 'renamed',
      content: 'updated content',
      tags: ['cat:bugfix'],
    });

    expect(store.getMemory('test-space', 'm')).toBeNull();
    const renamed = store.getMemory('test-space', 'renamed')!;
    expect(renamed.content).toBe('updated content');
    expect(renamed.tags).toEqual(['cat:bugfix']);
  });

  test('memory_update keeps a normalized YAML payload with tier and pinned', async () => {
    await addMemory('m', { tier: 2 });
    const tools = createMemoryTools(store);

    const res: any = await tools.memory_update.handler({
      space: 'test-space',
      name: 'm',
      pinned: true,
      tierTransition: 'promote',
    });

    expectYamlParity(res);
    expect(res.structuredContent.memory.tier).toBe(1);
    expect(res.structuredContent.memory.pinned).toBe(true);
    expect(res.structuredContent.memory.space).toBe('test-space');
    expect(res.structuredContent.memory.space_name).toBeUndefined();
  });

  test('exposes exactly 18 tools and no memory_patch', () => {
    const allTools = {
      ...createSpaceTools(store),
      ...createMemoryTools(store),
      ...createLinkTools(store),
      ...createStatusTools(store),
      ...createCheckpointTools(store),
      ...createSystemTools(),
    };

    expect(Object.keys(allTools)).toHaveLength(18);
    expect(allTools).not.toHaveProperty('memory_patch');
  });
});
