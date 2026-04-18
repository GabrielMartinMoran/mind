import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { zodToJsonSchema } from '../src/mcp/server';
import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createLinkTools } from '../src/mcp/tools/links';
import { createMemoryTools } from '../src/mcp/tools/memories';
import { createSpaceTools } from '../src/mcp/tools/spaces';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

type ListedTool = {
  name: string;
  description?: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
};

function requireListedTool(tools: ListedTool[], name: string): ListedTool {
  const tool = tools.find(candidate => candidate.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

afterEach(() => {
  store?.cleanup();
});

describe('MCP input schema fidelity', () => {
  test('zodToJsonSchema preserves Zod input metadata for MCP tool schemas', () => {
    const schema = zodToJsonSchema(
      z.object({
        requiredText: z.string().min(2),
        mode: z.enum(['active', 'completed', 'all']).optional(),
        maybeTier: z.number().int().min(1).max(3).nullable().optional(),
        tags: z.array(z.string()).min(1),
        limit: z.number().default(25),
      })
    );

    const jsonSchema = schema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.required).toEqual(['requiredText', 'tags']);
    expect(jsonSchema.properties.requiredText).toMatchObject({
      type: 'string',
      minLength: 2,
    });
    expect(jsonSchema.properties.mode).toMatchObject({
      type: 'string',
      enum: ['active', 'completed', 'all'],
    });
    expect(jsonSchema.properties.tags).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    });
    expect(jsonSchema.properties.limit).toMatchObject({
      type: 'number',
      default: 25,
    });
    expect(jsonSchema.properties.maybeTier).toMatchObject({
      anyOf: [{ type: 'integer', minimum: 1, maximum: 3 }, { type: 'null' }],
    });
  });

  test('declared MCP tool schemas preserve input constraints needed for tools/list exposure', () => {
    store = createTestStore();

    const memoryTools = createMemoryTools(store);
    const checkpointTools = createCheckpointTools(store);
    const spaceTools = createSpaceTools(store);

    const memoryQuerySchema = zodToJsonSchema(memoryTools.memory_query.schema) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const checkpointQuerySchema = zodToJsonSchema(checkpointTools.checkpoint_query.schema) as {
      properties: Record<string, unknown>;
    };
    const spaceCreateSchema = zodToJsonSchema(spaceTools.space_create.schema) as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(memoryQuerySchema.required).toEqual(['space']);
    expect(memoryQuerySchema.properties.tier).toMatchObject({
      anyOf: [{ type: 'integer', minimum: 1, maximum: 3 }, { type: 'null' }],
    });
    expect(memoryQuerySchema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 500,
    });
    expect(memoryQuerySchema.properties.offset).toMatchObject({
      type: 'integer',
      minimum: 0,
    });

    expect(checkpointQuerySchema.properties.status).toMatchObject({
      type: 'string',
      enum: ['active', 'completed', 'all'],
    });
    expect(checkpointQuerySchema.properties.limit).toMatchObject({
      type: 'number',
      default: 25,
    });
    expect(checkpointQuerySchema.properties.offset).toMatchObject({
      type: 'number',
      default: 0,
    });

    expect(spaceCreateSchema.required).toEqual(['name', 'description', 'tags']);
    expect(spaceCreateSchema.properties.name).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(spaceCreateSchema.properties.description).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(spaceCreateSchema.properties.tags).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    });
  });

  test('live MCP stdio tools/list exposes stable tool metadata subsets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-tools-list-'));
    const dbPath = join(tempDir, 'mind.db');
    const originalDbPath = process.env.MIND_DB_PATH;

    // Use absolute path to avoid "Module not found" when cwd differs
    const testDir = fileURLToPath(new URL('.', import.meta.url));
    const projectRoot = join(testDir, '..');
    const mindPath = join(projectRoot, 'src', 'mind.ts');

    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;

    try {
      process.env.MIND_DB_PATH = dbPath;
      transport = new StdioClientTransport({
        command: process.execPath,
        args: ['run', mindPath, 'mcp'],
        env: {
          ...process.env,
          MIND_DB_PATH: dbPath,
        },
      });
      client = new Client({ name: 'mind-tools-list-test', version: '1.0.0' });

      await client.connect(transport);
      // Wait for server to be fully initialized (helps under resource contention in full suite)
      await Bun.sleep(50);

      const { tools } = await client.listTools();
      const listedTools = tools as ListedTool[];

      expect(listedTools).toHaveLength(18);

      const memoryQueryTool = requireListedTool(listedTools, 'memory_query');
      expect(memoryQueryTool.inputSchema.required).toContain('space');
      expect(memoryQueryTool.inputSchema.properties?.tier).toMatchObject({
        anyOf: [{ type: 'integer', minimum: 1, maximum: 3 }, { type: 'null' }],
      });
      expect(memoryQueryTool.inputSchema.properties?.limit).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 500,
      });
      expect(memoryQueryTool.annotations).toMatchObject({ readOnlyHint: true });
      expect(memoryQueryTool.description).toContain('See system_instructions');

      const checkpointQueryTool = requireListedTool(listedTools, 'checkpoint_query');
      expect(checkpointQueryTool.inputSchema.properties?.status).toMatchObject({
        enum: ['active', 'completed', 'all'],
      });
      expect(checkpointQueryTool.inputSchema.properties?.limit).toMatchObject({ default: 25 });
      expect(checkpointQueryTool.inputSchema.properties?.offset).toMatchObject({ default: 0 });

      const spaceCreateTool = requireListedTool(listedTools, 'space_create');
      expect(spaceCreateTool.inputSchema.required).toEqual(
        expect.arrayContaining(['name', 'description', 'tags'])
      );
      expect(spaceCreateTool.inputSchema.properties?.tags).toMatchObject({ minItems: 1 });

      const systemInstructionsTool = requireListedTool(listedTools, 'system_instructions');
      expect(systemInstructionsTool.inputSchema).toMatchObject({
        type: 'object',
        properties: {},
      });

      const spaceDeleteTool = requireListedTool(listedTools, 'space_delete');
      expect(spaceDeleteTool.annotations).toMatchObject({ destructiveHint: true });

      const spaceGetTool = requireListedTool(listedTools, 'space_get');
      expect(spaceGetTool.description).toContain('orientation summary');
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
      if (transport) {
        await transport.close().catch(() => {});
      }

      if (originalDbPath === undefined) {
        delete process.env.MIND_DB_PATH;
      } else {
        process.env.MIND_DB_PATH = originalDbPath;
      }

      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('MCP Memory Tools', () => {
  test('memory_add should support pinned and links_to by name', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'target', 'target content', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'source',
      content: 'source content',
      tags: ['cat:decision'],
      pinned: true,
      links_to: ['target'],
    });

    expect(res.memory.pinned).toBe(true);
    expect(res.memory.space).toBe('proj');
    expect((res.memory as Record<string, unknown>).space_name).toBeUndefined();
    expect((res.memory as Record<string, unknown>).embedding).toBeUndefined();
    expect((res.memory as Record<string, unknown>).created_at).toBeUndefined();
    expect((res.memory as Record<string, unknown>).updated_at).toBeUndefined();
    // Verify link was created (use store internals since MCP no longer exposes IDs)
    const source = store.getMemory('proj', 'source')!;
    const links = store.getLinks(source.id);
    expect(links.length).toBe(1);
  });

  // This test was for the OLD atomic behavior - keeping a variant that tests
  // the new best-effort behavior where invalid links are reported but don't throw
  test('memory_add with invalid links does NOT throw (best-effort)', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    const tools = createMemoryTools(store);

    // Should NOT throw - best-effort behavior
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'source',
      content: 'source content',
      tags: ['test'],
      links_to: ['nonexistent-memory'],
    });

    // Memory should be created despite invalid link
    expect(store.getMemory('proj', 'source')).not.toBeNull();
    expect(res.memory).toBeDefined();
    expect(res.links_failed).toBeDefined();
    expect(res.links_failed?.length).toBe(1);
    expect(res.links_failed?.[0]?.ref).toBe('nonexistent-memory');
  });

  test('memory_read should include linked summaries by direction with refs', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    const base = await store.addMemory('proj', 'base', 'base content', { tags: ['cat:decision'] });
    const outgoing = await store.addMemory('proj', 'outgoing', 'outgoing content', {
      tags: ['cat:bugfix'],
    });
    const incoming = await store.addMemory('proj', 'incoming', 'incoming content', {
      tags: ['cat:pattern'],
    });
    store.link(base.id, outgoing.id);
    store.link(incoming.id, base.id);

    const tools = createMemoryTools(store);
    const res = await tools.memory_read.handler({ space: 'proj', name: 'base' });

    expect(res.memory).not.toBeNull();
    expect(res.memory?.pinned).toBe(false);
    expect(res.links_to.length).toBe(1);
    expect(res.linked_by.length).toBe(1);
    // Links include ref string instead of id
    expect(Object.keys(res.links_to[0] ?? {}).sort()).toEqual(
      ['changed_at', 'name', 'pinned', 'ref', 'space', 'tags', 'tier'].sort()
    );
    expect(res.links_to[0]?.ref).toBe('proj:outgoing');
    expect(res.linked_by[0]?.ref).toBe('proj:incoming');
  });

  test('memory_query should use default pagination values', async () => {
    store = createTestStore();
    store.createSpace('Credentials', 'Secrets', ['test']);
    await store.addMemory('Credentials', 'a', 'content', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({ space: 'Credentials' });

    expect(res.limit).toBe(25);
    expect(res.offset).toBe(0);
    expect(Array.isArray(res.memories)).toBe(true);
    expect(res.memories.length).toBe(1);
    expect(res.memories[0]?.space).toBe('Credentials');
    expect((res.memories[0] as Record<string, unknown>)?.space_name).toBeUndefined();
  });

  test('memory_query should respect limit and offset', async () => {
    store = createTestStore();
    store.createSpace('Credentials', 'Secrets', ['test']);
    await store.addMemory('Credentials', 'a', 'content', { tags: ['test'] });
    await store.addMemory('Credentials', 'b', 'content', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({ space: 'Credentials', limit: 1, offset: 0 });

    expect(res.memories.length).toBe(1);
    expect(res.limit).toBe(1);
    expect(res.offset).toBe(0);
    expect(res.total).toBe(2);
  });

  test('memory_query should return all memories when page covers all', async () => {
    store = createTestStore();
    store.createSpace('Credentials', 'Secrets', ['test']);
    await store.addMemory('Credentials', 'a', 'content', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({ space: 'Credentials', limit: 25, offset: 0 });

    expect(res.memories.length).toBe(1);
    expect(res.total).toBe(1);
  });

  test('memory_query should treat tier null as equivalent to omitting tier', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['type:project']);
    await store.addMemory('projects/mind', 't1-memory', 'hot content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/mind', 't2-memory', 'warm content', {
      tags: ['cat:pattern'],
      tier: 2,
    });
    await store.addMemory('projects/mind', 't3-memory', 'cold content', {
      tags: ['cat:discovery'],
      tier: 3,
    });

    const tools = createMemoryTools(store);
    const withoutTier = await tools.memory_query.handler({ space: 'projects/mind', limit: 10 });
    const withNullTier = await tools.memory_query.handler({
      space: 'projects/mind',
      tier: null,
      limit: 10,
    });

    expect(withNullTier.total).toBe(3);
    expect(withNullTier.memories.map((memory: { name: string }) => memory.name).sort()).toEqual(
      withoutTier.memories.map((memory: { name: string }) => memory.name).sort()
    );
    expect(
      withNullTier.memories.every((memory: { changed_at?: unknown }) => 'changed_at' in memory)
    ).toBe(true);
    expect(
      withNullTier.memories.some((memory: { created_at?: unknown }) => 'created_at' in memory)
    ).toBe(false);
    expect(
      withNullTier.memories.some((memory: { updated_at?: unknown }) => 'updated_at' in memory)
    ).toBe(false);
  });

  test('memory_query input schema should allow null tier and describe its meaning', async () => {
    store = createTestStore();

    const tools = createMemoryTools(store);
    const schema = zodToJsonSchema(tools.memory_query.schema) as {
      properties?: Record<string, unknown>;
    };
    const tierSchema = schema.properties?.tier as
      | { description?: string; type?: string | string[]; anyOf?: Array<{ type?: string }> }
      | undefined;

    expect(tierSchema).toBeDefined();
    expect(tierSchema!.description).toContain('Null means all tiers');

    const allowsNull =
      tierSchema!.type === 'null' ||
      (Array.isArray(tierSchema!.type) && tierSchema!.type.includes('null')) ||
      (typeof tierSchema!.type === 'string' && tierSchema!.type.includes('null')) ||
      tierSchema!.anyOf?.some((entry: { type?: string }) => entry.type === 'null');

    expect(allowsNull).toBe(true);
  });
});

describe('MCP Checkpoint Tools', () => {
  test('checkpoint_save should create checkpoint in the same space', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);
    const res = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Implement auth',
      pending: 'Fix login bug',
    });

    expect(res.checkpoint).toBeDefined();
    const checkpoint = res.checkpoint;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.space).toBe('myproject');
    expect(checkpoint?.tags).toBeDefined();
    expect(checkpoint?.tags).toContain('checkpoint');
    expect(checkpoint?.tags).toContain('active');
    expect((res as any).structuredContent?.checkpoint?.space).toBe('myproject');
  });

  test('checkpoint_save should update existing active checkpoint', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    // Create first checkpoint
    await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'First goal',
      pending: 'First pending',
    });

    // Update it
    const res = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Updated goal',
      pending: 'Updated pending',
    });

    expect((res as any).structuredContent?.checkpoint?.space).toBe('myproject');

    // Should still be one checkpoint (filter by tag to exclude non-checkpoint memories)
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    expect(memories.length).toBe(1);

    const firstMem = memories[0];
    expect(firstMem).toBeDefined();
    const mem = store.getMemoryById(firstMem!.id);
    expect(mem).toBeDefined();
    const content = JSON.parse(mem!.content);
    expect(content.goal).toBe('Updated goal');
  });

  test('checkpoint_load should return checkpoint by name', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    const saved = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'My goal',
      pending: 'My pending',
      notes: 'Some context',
    });

    const res = await tools.checkpoint_load.handler({
      space: 'myproject',
      checkpointName: saved.checkpoint!.name,
    });

    expect(res.checkpoint).toBeDefined();
    const checkpoint = res.checkpoint;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.content?.goal).toBe('My goal');
    expect(checkpoint?.content?.pending).toBe('My pending');
    expect(checkpoint?.content?.notes).toBe('Some context');
  });

  test('checkpoint_load without checkpointName throws error', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);
    await expect(
      tools.checkpoint_load.handler({
        space: 'myproject',
      })
    ).rejects.toThrow('checkpointName is required');
  });

  test('checkpoint_done should mark as completed and demote (old behavior - Phase 2 changes this)', async () => {
    // NOTE: This test describes the OLD behavior. Phase 2 changes checkpoint_done to
    // transform the checkpoint into a session memory in sessions/<repo>.
    // This test is kept for reference but the behavior has changed.
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    const created = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Goal',
      pending: 'Pending',
    });

    const res = await tools.checkpoint_done.handler({
      space: 'myproject',
      checkpointName: created.checkpoint!.name,
      summary: 'Fixed the bug',
    });

    // New behavior: creates session memory in sessions/myproject
    expect(res.session_memory).toBeDefined();
    expect(res.session_memory?.space).toBe('sessions/myproject');
    expect(res.session_memory?.tags).toContain('type:session');
    expect(res.session_memory?.tags).toContain('cat:summary');
    expect((res as any).structuredContent?.session_memory?.space).toBe('sessions/myproject');
  });

  test('checkpoint_query should list all checkpoints', async () => {
    // NOTE: Phase 2 changes checkpoint_done to DELETE the checkpoint instead of marking complete.
    // This test verifies that after checkpoint_done, the checkpoint is deleted.
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    const created = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Goal',
      pending: 'Pending',
    });

    await tools.checkpoint_done.handler({
      space: 'myproject',
      checkpointName: created.checkpoint!.name,
      summary: 'Done',
    });

    // Checkpoint should be deleted after transformation
    const res = await tools.checkpoint_query.handler({
      space: 'myproject',
    });

    // After Phase 2, checkpoint is deleted, so list should be empty
    expect(res.checkpoints.length).toBe(0);
  });

  test('checkpoint_save with related memories should create links', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);
    const mem = await store.addMemory('myproject', 'auth', 'JWT auth', { tags: ['test'] });

    const tools = createCheckpointTools(store);
    const res = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Fix auth',
      pending: 'Debug issue',
      linked_memories: ['auth'],
    });

    expect(res.checkpoint).toBeDefined();
    const checkpoint = res.checkpoint;
    expect(checkpoint).toBeDefined();
    // Look up checkpoint by name in the same space
    const cpMemory = store.getMemory('myproject', checkpoint!.name);
    expect(cpMemory).toBeDefined();
    const links = store.getLinks(cpMemory!.id);
    expect(links.length).toBe(1);
    const firstLink = links[0];
    expect(firstLink).toBeDefined();
    expect(firstLink?.target_id).toBe(mem.id);
  });

  test('checkpoint_load should load specific checkpoint by name', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    // Create first checkpoint
    await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'First goal',
      pending: 'First pending',
    });

    // Complete first checkpoint (creates session memory, deletes checkpoint)
    await tools.checkpoint_done.handler({
      space: 'myproject',
      summary: 'Done with first',
    });

    // Create second checkpoint
    await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Second goal',
      pending: 'Second pending',
    });

    // Get the second checkpoint (first one was deleted)
    const checkpoints = store.listMemories('myproject', { tag: 'checkpoint' });
    expect(checkpoints.length).toBe(1);
    const secondCp = checkpoints[0];
    expect(secondCp).toBeDefined();

    // Load specific checkpoint by name
    const res = await tools.checkpoint_load.handler({
      space: 'myproject',
      checkpointName: secondCp!.name,
    });

    expect(res.checkpoint).toBeDefined();
    expect(res.checkpoint?.name).toBe(secondCp!.name);
    // The content should be from the second checkpoint
    expect(res.checkpoint?.content?.goal).toBe('Second goal');
  });

  test('checkpoint_load should throw error for non-existent checkpoint name', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);

    const tools = createCheckpointTools(store);

    await expect(
      tools.checkpoint_load.handler({
        space: 'myproject',
        checkpointName: 'nonexistent-checkpoint',
      })
    ).rejects.toThrow('not found');
  });

  test('checkpoint_load should return context_hits for valid checkpoint', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'A project', ['test']);
    // Add some memories so context_hits can find something
    await store.addMemory('myproject', 'auth', 'JWT auth flow', { tags: ['test'] });

    const tools = createCheckpointTools(store);
    const saved = await tools.checkpoint_save.handler({
      space: 'myproject',
      goal: 'Stabilize auth',
      pending: 'Fix token refresh',
    });

    const res = await tools.checkpoint_load.handler({
      space: 'myproject',
      checkpointName: saved.checkpoint!.name,
    });

    expect(res.checkpoint).toBeDefined();
    // context_hits should NOT be in response (removed)
    expect((res as any).context_hits).toBeUndefined();
    // response should NOT have recoveryPack
    expect((res as any).recoveryPack).toBeUndefined();
  });
});

describe('MCP Spaces Tools', () => {
  test('space_create should create a space', async () => {
    store = createTestStore();

    const tools = createSpaceTools(store);
    const res = await tools.space_create.handler({
      name: 'myproject',
      description: 'My project',
      tags: ['project'],
    });

    expect(res.space).toBeDefined();
    expect(res.space?.name).toBe('myproject');
    expect(res.space?.description).toBe('My project');
    expect(res.space?.changed_at).toEqual(expect.any(String));
    expect((res.space as Record<string, unknown>)?.created_at).toBeUndefined();
    expect((res.space as Record<string, unknown>)?.updated_at).toBeUndefined();
    expect((res as any).structuredContent?.space?.name).toBe('myproject');
  });

  test('space_list should list spaces', async () => {
    store = createTestStore();
    store.createSpace('proj1', 'Project 1', ['test']);
    store.createSpace('proj2', 'Project 2', ['test']);

    const tools = createSpaceTools(store);
    const res = await tools.space_list.handler({});

    expect(res.spaces.length).toBe(2);
  });

  test('space_get should return space details', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'My project', ['test']);
    await store.addMemory('myproject', 'preview', 'Preview content', {
      tier: 1,
      tags: ['cat:decision'],
    });

    const tools = createSpaceTools(store);
    const res = await tools.space_get.handler({ name: 'myproject' });

    expect(res.space).toBeDefined();
    expect(res.space?.name).toBe('myproject');
    expect(res.space?.changed_at).toEqual(expect.any(String));
    expect((res.space as Record<string, unknown>)?.created_at).toBeUndefined();
    expect((res.space as Record<string, unknown>)?.updated_at).toBeUndefined();
    expect(res.overview).toEqual({
      total_memories: 1,
      active_checkpoints: 0,
      by_tier: [
        { tier: 1, count: 1, pinned: 0 },
        { tier: 2, count: 0, pinned: 0 },
        { tier: 3, count: 0, pinned: 0 },
      ],
    });
    expect(res.trending_memories.tier_1.memories[0]?.changed_at).toEqual(expect.any(String));
    expect(
      (res.trending_memories.tier_1.memories[0] as Record<string, unknown>)?.updated_at
    ).toBeUndefined();
    expect(res.active_checkpoints).toEqual({ total: 0, checkpoints: [] });
  });

  test('space_update should update description', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'Old desc', ['test']);

    const tools = createSpaceTools(store);
    const res = await tools.space_update.handler({
      name: 'myproject',
      description: 'New desc',
    });

    const space = store.getSpace('myproject');
    expect(space?.description).toBe('New desc');
    expect((res as any).structuredContent?.space?.description).toBe('New desc');
  });

  test('space_delete should delete a space', async () => {
    store = createTestStore();
    store.createSpace('myproject', 'To delete', ['test']);

    const tools = createSpaceTools(store);
    const res = await tools.space_delete.handler({ name: 'myproject' });

    expect(res.content[0]?.text).toContain('deleted');
    expect(store.getSpace('myproject')).toBeNull();
  });
});

describe('MCP Links Tools', () => {
  test('link_create should create link', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });

    const tools = createLinkTools(store);
    const res = await tools.link_create.handler({
      sourceRef: 'test:mem1',
      targetRef: 'test:mem2',
      label: 'depends-on',
    });

    expect(res.content[0]?.text).toContain('Linked:');

    const links = store.getLinks(mem1.id);
    expect(links.length).toBe(1);
    const firstLink = links[0];
    expect(firstLink).toBeDefined();
    expect(firstLink?.label).toBe('depends-on');
  });

  test('link_delete should delete link', async () => {
    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });
    store.link(mem1.id, mem2.id);

    const tools = createLinkTools(store);
    await tools.link_delete.handler({
      sourceRef: 'test:mem1',
      targetRef: 'test:mem2',
    });

    const links = store.getLinks(mem1.id);
    expect(links.length).toBe(0);
  });

  // links_list has been removed - use memory_read instead (it now includes linked memory summaries)
});

describe('MCP Memory Tools - links_to Best-Effort (Phase 1a)', () => {
  test('memory_add with mixed valid/invalid links creates memory and reports failures', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'existing-memory', 'existing content', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'new-memory',
      content: 'test content',
      tags: ['cat:decision'],
      links_to: ['existing-memory', 'nonexistent-memory'],
    });

    // Memory should be created
    expect(store.getMemory('proj', 'new-memory')).not.toBeNull();
    expect(res.memory).toBeDefined();
    expect(res.memory?.name).toBe('new-memory');

    // Should report what worked and what failed
    expect(res.links_created).toBeDefined();
    expect(res.links_created?.length).toBe(1);
    expect(res.links_created?.[0]?.source).toBe('new-memory');
    expect(res.links_created?.[0]?.target).toBe('existing-memory');

    expect(res.links_failed).toBeDefined();
    expect(res.links_failed?.length).toBe(1);
    expect(res.links_failed?.[0]?.ref).toBe('nonexistent-memory');

    // Verify the valid link was actually created
    const newMem = store.getMemory('proj', 'new-memory')!;
    const links = store.getLinks(newMem.id);
    expect(links.length).toBe(1);
    expect(links[0]?.target_id).toBe(store.getMemory('proj', 'existing-memory')!.id);
  });

  test('memory_add with all invalid links still creates the memory', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);

    const tools = createMemoryTools(store);
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'new-memory',
      content: 'test content',
      tags: ['cat:decision'],
      links_to: ['missing-1', 'missing-2'],
    });

    // Memory should still be created despite all links failing
    expect(store.getMemory('proj', 'new-memory')).not.toBeNull();
    expect(res.memory).toBeDefined();

    // Should report all links as failed
    expect(res.links_created).toBeDefined();
    expect(res.links_created?.length).toBe(0);

    expect(res.links_failed).toBeDefined();
    expect(res.links_failed?.length).toBe(2);
    expect(res.links_failed?.map((f: { ref: string }) => f.ref).sort()).toEqual([
      'missing-1',
      'missing-2',
    ]);
  });

  test('memory_add with all valid links has empty links_failed array', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);
    await store.addMemory('proj', 'existing-1', 'content 1', { tags: ['test'] });
    await store.addMemory('proj', 'existing-2', 'content 2', { tags: ['test'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'new-memory',
      content: 'test content',
      tags: ['cat:decision'],
      links_to: ['existing-1', 'existing-2'],
    });

    // Memory should be created
    expect(store.getMemory('proj', 'new-memory')).not.toBeNull();

    // Both links should be created
    expect(res.links_created).toBeDefined();
    expect(res.links_created?.length).toBe(2);

    expect(res.links_failed).toBeDefined();
    expect(res.links_failed?.length).toBe(0);

    // Verify links in database
    const newMem = store.getMemory('proj', 'new-memory')!;
    const links = store.getLinks(newMem.id);
    expect(links.length).toBe(2);
  });

  test('memory_add with no links_to works as before', async () => {
    store = createTestStore();
    store.createSpace('proj', 'Project', ['test']);

    const tools = createMemoryTools(store);
    const res = await tools.memory_add.handler({
      space: 'proj',
      name: 'new-memory',
      content: 'test content',
      tags: ['cat:decision'],
    });

    expect(store.getMemory('proj', 'new-memory')).not.toBeNull();
    expect(res.memory).toBeDefined();
    expect(res.links_created?.length).toBe(0);
    expect(res.links_failed?.length).toBe(0);
  });
});

describe('MCP Memory Tools - search parameter in memory_query (Phase 1b)', () => {
  test('memory_query with search parameter returns FTS5 results', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);
    await store.addMemory('projects/mind', 'auth-jwt', 'JWT authentication implementation', {
      tags: ['cat:decision'],
    });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({
      space: 'projects/mind',
      search: 'JWT',
    });

    expect(res.memories).toBeDefined();
    expect(res.memories.length).toBeGreaterThan(0);
    // Should find the memory with JWT in content
    expect(res.memories.some((m: { name: string }) => m.name === 'auth-jwt')).toBe(true);
    expect(res.search_method).toBe('fts5');
  });

  test('memory_query without search uses SQL filters only', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);
    await store.addMemory('projects/mind', 'memory-1', 'content', { tags: ['cat:decision'] });
    await store.addMemory('projects/mind', 'memory-2', 'content', { tags: ['cat:bugfix'] });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({
      space: 'projects/mind',
      tag: 'cat:decision',
    });

    expect(res.memories).toBeDefined();
    expect(res.memories.length).toBe(1);
    expect(res.memories[0]?.name).toBe('memory-1');
    // When no search is used, search_method should be undefined or not present
    expect(res.search_method).toBeUndefined();
  });

  test('memory_query response includes search_method field when search is used', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);
    await store.addMemory('projects/mind', 'test-memory', 'hello world content', {
      tags: ['test'],
    });

    const tools = createMemoryTools(store);
    const res = await tools.memory_query.handler({
      space: 'projects/mind',
      search: 'hello',
    });

    expect(res).toHaveProperty('search_method');
    expect(res.search_method).toBeDefined();
  });
});

describe('MCP Search Tool Removed (Phase 1b Step 2)', () => {
  test('search tool is not available in MCP tool list', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    // Verify search is not in the tools returned by createMemoryTools
    const memoryTools = createMemoryTools(store) as any;
    expect(memoryTools['search']).toBeUndefined();

    // Verify there's no search tool in the combined MCP tools
    const tools = {
      ...createMemoryTools(store),
      ...createSpaceTools(store),
      ...createLinkTools(store),
      ...createCheckpointTools(store),
    } as any;
    expect(tools['search']).toBeUndefined();
  });

  test('memory_query is available (search tool removed but memory_query works)', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);
    await store.addMemory('projects/mind', 'test-memory', 'hello world', { tags: ['test'] });

    const tools = createMemoryTools(store);
    expect(tools['memory_query']).toBeDefined();

    // memory_query should work
    const res = await tools.memory_query.handler({
      space: 'projects/mind',
      search: 'hello',
    });
    expect(res.memories.length).toBe(1);
    expect(res.search_method).toBe('fts5');
  });
});

describe('MCP Checkpoint Tools - Session Transformation (Phase 2)', () => {
  test('checkpoint_done creates session memory in sessions/<repo> and deletes checkpoint', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);
    await store.addMemory('projects/mind', 'memory-1', 'content 1', { tags: ['cat:decision'] });
    await store.addMemory('projects/mind', 'memory-2', 'content 2', { tags: ['cat:bugfix'] });

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint with related refs
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Complete API refactor',
      pending: 'Write tests',
      linked_memories: ['memory-1', 'memory-2'],
    });

    // Call checkpoint_done
    const _res = await checkpointTools.checkpoint_done.handler({
      space: 'projects/mind',
      summary: 'Finished the API refactor',
    });

    // Session memory should be created in sessions/mind
    const sessionsSpace = store.getSpace('sessions/mind');
    expect(sessionsSpace).not.toBeNull();

    // Get the session memory
    const sessionMemories = store.queryMemories({ space: 'sessions/mind' });
    expect(sessionMemories.length).toBe(1);
    const sessionMemory = sessionMemories[0]!;
    expect(sessionMemory.tags).toContain('type:session');
    expect(sessionMemory.tags).toContain('cat:summary');

    // Original checkpoint should be deleted
    const checkpoints = store.listMemories('projects/mind', { tag: 'checkpoint' });
    expect(checkpoints.length).toBe(0);

    // Session memory should have links to memory-1 and memory-2
    const sessionFull = store.getMemory('sessions/mind', sessionMemory.name)!;
    const links = store.getLinks(sessionFull.id);
    expect(links.length).toBe(2);
  });

  test('checkpoint_done with no linked_memories still creates session memory', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint without related refs
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Simple task',
      pending: 'Done',
    });

    // Call checkpoint_done
    const _res = await checkpointTools.checkpoint_done.handler({
      space: 'projects/mind',
      summary: 'Task completed',
    });

    // Session memory should be created in sessions/mind
    const sessionsSpace = store.getSpace('sessions/mind');
    expect(sessionsSpace).not.toBeNull();

    // Get the session memory
    const sessionMemories = store.queryMemories({ space: 'sessions/mind' });
    expect(sessionMemories.length).toBe(1);
    expect(sessionMemories[0]!.tags).toContain('type:session');
    expect(sessionMemories[0]!.tags).toContain('cat:summary');
  });

  test('calling checkpoint_done twice returns error on second call', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create and complete first checkpoint
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'First task',
      pending: 'Done',
    });

    await checkpointTools.checkpoint_done.handler({
      space: 'projects/mind',
      summary: 'First task done',
    });

    // Second call should fail
    await expect(
      checkpointTools.checkpoint_done.handler({
        space: 'projects/mind',
        summary: 'Trying to complete again',
      })
    ).rejects.toThrow('No active checkpoint found');

    // Should only have one session memory (not two)
    const sessionMemories = store.queryMemories({ space: 'sessions/mind' });
    expect(sessionMemories.length).toBe(1);
  });
});

describe('MCP Checkpoint Tools - checkpoint_query (Phase 3)', () => {
  test('checkpoint_query with status="active" returns only active checkpoints with goal and pending', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Active task',
      pending: 'Done',
    });

    // Verify only active checkpoint is returned
    const res = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      status: 'active',
    });

    expect(res.checkpoints).toBeDefined();
    expect(res.checkpoints.length).toBe(1);
    expect(res.checkpoints[0]?.tags).toContain('active');
    // Should include goal and pending preview
    expect(res.checkpoints[0]?.goal).toBe('Active task');
    expect(res.checkpoints[0]?.pending).toBe('Done');
  });

  test('checkpoint_query returns full pending longer than 50 chars', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint with long pending text
    const longPending =
      'This is a very long pending task description that exceeds fifty characters';
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Short goal',
      pending: longPending,
    });

    const res = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
    });

    expect(res.checkpoints).toBeDefined();
    expect(res.checkpoints.length).toBe(1);
    expect(res.checkpoints[0]?.goal).toBe('Short goal');
    expect(res.checkpoints[0]?.pending).toBe(longPending);
    expect((res.checkpoints[0] as any)?.changed_at).toEqual(expect.any(String));
  });

  test('checkpoint_query with date range filters correctly', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Dated task',
      pending: 'Done',
    });

    // Query with today's date
    const today = new Date().toISOString().split('T')[0];
    const res = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      from: today,
      to: today,
    });

    expect(res.checkpoints).toBeDefined();
    expect(res.checkpoints.length).toBe(1);

    // Query with future date should return nothing
    const futureRes = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      from: '2099-01-01',
      to: '2099-12-31',
    });

    expect(futureRes.checkpoints.length).toBe(0);
  });

  test('checkpoint_query with tag filter works', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create a checkpoint (it has 'checkpoint' and 'active' tags)
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Tagged task',
      pending: 'Done',
    });

    // Query with checkpoint tag should return the checkpoint
    const res = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      tag: 'checkpoint',
    });

    expect(res.checkpoints).toBeDefined();
    expect(res.checkpoints.length).toBe(1);

    // Query with non-existent tag should return nothing
    const emptyRes = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      tag: 'nonexistent',
    });

    expect(emptyRes.checkpoints.length).toBe(0);
  });

  test('checkpoint_query respects limit and offset', async () => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Mind project', ['test']);

    const checkpointTools = createCheckpointTools(store);

    // Create first checkpoint and complete it (creates session, deletes checkpoint)
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'First task',
      pending: 'Done',
    });
    await checkpointTools.checkpoint_done.handler({
      space: 'projects/mind',
      summary: 'First done',
    });

    // Create second checkpoint
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/mind',
      goal: 'Second task',
      pending: 'Done',
    });

    // Query with limit 1
    const res = await checkpointTools.checkpoint_query.handler({
      space: 'projects/mind',
      limit: 1,
      offset: 0,
    });

    expect(res.checkpoints.length).toBe(1);
    expect(res.total).toBe(1); // Only 1 active checkpoint (first was completed/deleted)
    expect(res.limit).toBe(1);
    expect(res.offset).toBe(0);
  });
});
