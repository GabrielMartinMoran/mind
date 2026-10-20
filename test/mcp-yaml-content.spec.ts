import { afterEach, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createLinkTools } from '../src/mcp/tools/links';
import { createMemoryTools } from '../src/mcp/tools/memories';
import { createSpaceTools } from '../src/mcp/tools/spaces';
import { createStatusTools } from '../src/mcp/tools/status';
import { createSystemTools } from '../src/mcp/tools/system';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

function expectYamlParity(response: {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}) {
  expect(response.content).toHaveLength(1);
  expect(response.content[0]).toEqual({
    type: 'text',
    text: expect.any(String),
  });

  const yamlText = response.content[0]!.text;
  expect(yamlText).not.toContain('```');
  expect(yamlText.trim().length).toBeGreaterThan(0);
  expect(response.structuredContent).toBeDefined();
  expect(parseYaml(yamlText)).toEqual(response.structuredContent);
}

function expectNoBoundaryLeaks(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectNoBoundaryLeaks(item);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  expect(record).not.toHaveProperty('embedding');
  expect(record).not.toHaveProperty('space_name');
  expect(record).not.toHaveProperty('access_count');
  expect(record).not.toHaveProperty('last_accessed_at');
  expect(record).not.toHaveProperty('created_at');
  expect(record).not.toHaveProperty('updated_at');
  expect(record).not.toHaveProperty('fts_id');
  expect(record).not.toHaveProperty('space_id');

  for (const nestedValue of Object.values(record)) {
    expectNoBoundaryLeaks(nestedValue);
  }
}

describe('MCP YAML content stage 1', () => {
  test('in-scope tools return raw YAML content matching structured payloads', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['type:project']);
    await store.addMemory('projects/mind', 'related-memory', 'Related content', {
      tags: ['cat:decision'],
    });

    const spaceTools = createSpaceTools(store);
    const memoryTools = createMemoryTools(store);
    const checkpointTools = createCheckpointTools(store);
    const statusTools = createStatusTools(store);

    expectYamlParity(
      await spaceTools.space_create.handler({
        name: 'projects/created',
        description: 'Created project',
        tags: ['type:project'],
      })
    );

    expectYamlParity(await spaceTools.space_list.handler({}));
    expectYamlParity(await spaceTools.space_get.handler({ name: 'projects/mind' }));
    expectYamlParity(
      await spaceTools.space_update.handler({
        name: 'projects/mind',
        description: 'Updated description',
      })
    );

    expectYamlParity(
      await memoryTools.memory_add.handler({
        space: 'projects/mind',
        name: 'yaml-memory',
        content: 'YAML memory content',
        tags: ['cat:bugfix'],
        links_to: ['related-memory'],
      })
    );

    expectYamlParity(
      await memoryTools.memory_update.handler({
        space: 'projects/mind',
        name: 'yaml-memory',
        content: 'Updated YAML memory content',
      })
    );

    const memoryRead: any = await memoryTools.memory_read.handler({
      space: 'projects/mind',
      name: 'yaml-memory',
      noPromote: true,
    });
    expectYamlParity(memoryRead);
    expectNoBoundaryLeaks(memoryRead.structuredContent);
    expect(memoryRead.structuredContent?.tier_change).toBeNull();

    const memoryQuery: any = await memoryTools.memory_query.handler({
      space: 'projects/mind',
      limit: 5,
      offset: 0,
    });
    expectYamlParity(memoryQuery);
    expectNoBoundaryLeaks(memoryQuery.structuredContent);
    expect(memoryQuery.structuredContent).not.toHaveProperty('search_method');

    // Search results expose confidence + methods, with YAML parity retained.
    const memorySearch: any = await memoryTools.memory_query.handler({
      space: 'projects/mind',
      search: 'yaml',
    });
    expectYamlParity(memorySearch);
    expectNoBoundaryLeaks(memorySearch.structuredContent);
    expect(typeof memorySearch.structuredContent?.search_method).toBe('string');
    const searchedItem = memorySearch.structuredContent?.memories?.[0];
    expect(searchedItem).toBeDefined();
    expect(searchedItem.confidence).toMatch(/^(high|medium|low)$/);
    expect(Array.isArray(searchedItem.methods)).toBe(true);
    expect(searchedItem.score).toBeGreaterThan(0);

    const checkpointSave = await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Ship stage 1',
      pending: 'Update MCP YAML responses',
      linked_memories: ['yaml-memory'],
    });
    expectYamlParity(checkpointSave);

    expectYamlParity(
      await checkpointTools.checkpoint_load.handler({
        space: 'projects/mind',
        checkpointName: checkpointSave.checkpoint!.name,
      })
    );

    const checkpointQuery: any = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
    });
    expectYamlParity(checkpointQuery);
    expect(checkpointQuery.structuredContent?.error).toBeNull();

    expectYamlParity(
      await checkpointTools.checkpoint_done.handler({
        space: 'projects/mind',
        checkpointName: checkpointSave.checkpoint!.name,
        summary: 'Stage 1 shipped',
      })
    );

    expectYamlParity(await statusTools.status.handler({ space: 'projects/mind' }));
  });

  test('in-scope YAML payloads are normalized before serialization', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['type:project']);

    const spaceTools = createSpaceTools(store);
    const memoryTools = createMemoryTools(store);

    const addResponse: any = await memoryTools.memory_add.handler({
      space: 'projects/mind',
      name: 'normalized-memory',
      content: 'Normalized content',
      tags: ['cat:decision'],
    });
    expectYamlParity(addResponse);
    expectNoBoundaryLeaks(addResponse.structuredContent);
    expect(addResponse.structuredContent?.memory?.space).toBe('projects/mind');
    expect(addResponse.structuredContent?.memory?.changed_at).toEqual(expect.any(String));

    await memoryTools.memory_add.handler({
      space: 'projects/mind',
      name: 'living-reference',
      content: 'Living reference content',
      tags: ['type:reference', 'status:living'],
    });

    const spaceGetResponse: any = await spaceTools.space_get.handler({ name: 'projects/mind' });
    expectYamlParity(spaceGetResponse);
    expectNoBoundaryLeaks(spaceGetResponse.structuredContent);
    expect(spaceGetResponse.structuredContent?.space?.changed_at).toEqual(expect.any(String));
    expect(
      spaceGetResponse.structuredContent?.trending_memories?.tier_2?.memories?.[0]?.changed_at
    ).toEqual(expect.any(String));
    expect(spaceGetResponse.structuredContent?.references?.memories?.[0]?.name).toBe(
      'living-reference'
    );
    expect(spaceGetResponse.structuredContent?.references?.memories?.[0]?.changed_at).toEqual(
      expect.any(String)
    );
  });

  test('checkpoint_query reports missing space with explicit error field and YAML parity', async () => {
    store = createTestStore();

    const tools = createCheckpointTools(store);
    const response: any = await tools.checkpoint_query.handler({
      space: 'projects/missing',
    });

    expect(response.structuredContent).toEqual({
      checkpoints: [],
      total: 0,
      limit: 25,
      offset: 0,
      error: {
        code: 'space_not_found',
        message: 'Space "projects/missing" not found.',
      },
    });
    expectYamlParity(response);
  });

  test('content-only tools remain unchanged and system_instructions stays as protocol text', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['type:project']);
    const source = await store.addMemory('projects/mind', 'source', 'Source content', {
      tags: ['cat:decision'],
    });
    await store.addMemory('projects/mind', 'target', 'Target content', {
      tags: ['cat:bugfix'],
    });

    const linkTools = createLinkTools(store);
    const spaceTools = createSpaceTools(store);
    const memoryTools = createMemoryTools(store);
    const systemTools = createSystemTools();

    const linkCreate: any = await linkTools.link_create.handler({
      sourceRef: 'projects/mind:source',
      targetRef: 'projects/mind:target',
      label: 'relates_to',
    });
    expect(linkCreate.structuredContent).toBeUndefined();
    expect(linkCreate.content[0]?.text).toContain('Linked:');

    const linkDelete: any = await linkTools.link_delete.handler({
      sourceRef: 'projects/mind:source',
      targetRef: 'projects/mind:target',
    });
    expect(linkDelete.structuredContent).toBeUndefined();
    expect(linkDelete.content[0]?.text).toContain('Unlinked:');

    const memoryDelete: any = await memoryTools.memory_delete.handler({
      space: 'projects/mind',
      name: 'target',
    });
    expect(memoryDelete.structuredContent).toBeUndefined();
    expect(memoryDelete.content[0]?.text).toContain('deleted');

    const spaceDelete: any = await spaceTools.space_delete.handler({ name: 'projects/mind' });
    expect(spaceDelete.structuredContent).toBeUndefined();
    expect(spaceDelete.content[0]?.text).toContain('deleted');

    expect(store.getLinks(source.id)).toEqual([]);

    // @ts-ignore — handler accepts 0 args but type system requires 1
    const systemInstructions: any = await systemTools.system_instructions.handler();
    expect(systemInstructions.structuredContent).toBeUndefined();
    expect(systemInstructions.content[0]?.text).toContain('Mind Memory Protocol');
    expect(systemInstructions.content[0]?.text).not.toContain('```yaml');
  });
});
