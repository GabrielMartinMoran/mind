import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
  delete process.env.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE;
});

// =============================================================================
// Phase 6: Integration Tests — Complete Workflows
// =============================================================================

describe('Phase 6: Integration Tests — Complete Workflows', () => {
  beforeEach(() => {
    store = createTestStore();
    store.createSpace('projects/test-repo', 'Test project space', ['type:project']);
    store.createSpace('other-space', 'Other space', ['test']);
  });

  // ==========================================================================
  // Test 1: Complete session workflow
  // ==========================================================================
  test('complete session workflow: create checkpoint → work → checkpoint_done → same-space session memory created', async () => {
    const checkpointTools = createCheckpointTools(store);
    const memoryTools = createMemoryTools(store);

    // 1. Create a checkpoint
    const created = await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Implement user auth',
      pending: 'Write tests, update docs',
      notes: 'Using JWT with refresh tokens',
    });

    expect(created.checkpoint).toBeDefined();
    const checkpointName = created.checkpoint!.name;
    expect(created.checkpoint!.tags).toContain('checkpoint');
    expect(created.checkpoint!.tags).toContain('active');

    // 2. Add memories with links (some valid, some invalid)
    const validMem = await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'auth-decision',
      content: 'Using JWT with refresh tokens for auth',
      tags: ['cat:decision'],
    });
    expect(validMem.memory).toBeDefined();

    const memoryWithLinks = await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'auth-implementation',
      content: 'JWT implementation complete',
      tags: ['cat:discovery'],
      links_to: ['auth-decision', 'nonexistent-memory'],
    });

    // Memory should be created even with invalid link
    expect(memoryWithLinks.memory).toBeDefined();
    expect(memoryWithLinks.links_created).toHaveLength(1);
    expect(memoryWithLinks.links_failed).toHaveLength(1);
    expect(memoryWithLinks.links_failed[0]?.ref).toBe('nonexistent-memory');

    // 3. Update checkpoint with progress; clearing pending signals completion
    const updated = await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Implement user auth',
      pending: '', // work complete
      notes: 'Tests written, implementation complete',
    });
    expect(updated.checkpoint).toBeDefined();

    // 4. Call checkpoint_done with summary
    const done = await checkpointTools.checkpoint_done.handler({
      space: 'projects/test-repo',
      checkpointName: checkpointName,
      summary: 'Auth implementation complete with JWT and refresh tokens',
    });

    // 5. Verify session memory exists in the project space
    expect(done.session_memory).toBeDefined();
    expect(done.session_memory!.space).toBe('projects/test-repo');
    expect(done.session_memory!.tags).toContain('type:session');
    expect(done.session_memory!.tags).toContain('cat:summary');

    const sessionMem = store.getMemory('projects/test-repo', done.session_memory!.name);
    expect(sessionMem).toBeDefined();
    expect(sessionMem!.tier).toBe(3);
    const content = JSON.parse(sessionMem!.content);
    expect(content.goal).toBe('Implement user auth');
    expect(content.whatWasDone).toBe('Auth implementation complete with JWT and refresh tokens');
    expect(content.sessionSummary.schema).toBe('mind.session-summary/v1');
    expect(content.sessionSummary.writer.id).toBe('checkpoint_done');
    expect(content.sessionSummary.provenance.checkpoint.space).toBe('projects/test-repo');
    expect(content.sessionSummary.provenance.checkpoint.name).toBe(checkpointName);

    // 6. Verify original checkpoint was deleted
    expect(store.getMemory('projects/test-repo', checkpointName)).toBeNull();

    // 7. Verify links_failed were reported for invalid links
    // (already verified step 2)
  });

  // ==========================================================================
  // Test 2: links_to best-effort integration
  // ==========================================================================
  test('memory_add with links_to: best-effort behavior', async () => {
    const memoryTools = createMemoryTools(store);

    // Create a valid memory to link to
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'valid-memory',
      content: 'This is a valid memory',
      tags: ['cat:pattern'],
    });

    // Add memory with mix of valid and invalid links_to
    const res = await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'new-memory',
      content: 'Memory with mixed links',
      tags: ['cat:discovery'],
      links_to: [
        'valid-memory', // valid: bare name in same space
        'projects/test-repo:valid-memory', // valid: fully qualified
        'nonexistent-memory', // invalid: doesn't exist
        'other-space:also-nonexistent', // invalid: different space, doesn't exist
        'invalid-no-colon-ref', // invalid: no colon
      ],
    });

    // Memory should be created
    expect(res.memory).toBeDefined();
    expect(res.memory!.name).toBe('new-memory');

    // links_created should have the valid ones
    expect(res.links_created).toHaveLength(2);
    const createdRefs = res.links_created.map((l: any) => l.target);
    expect(createdRefs).toContain('valid-memory');
    expect(createdRefs).toContain('valid-memory'); // both formats resolve to same memory

    // links_failed should have the invalid ones with reasons
    expect(res.links_failed).toHaveLength(3);
    const failedRefs = res.links_failed.map((l: any) => l.ref);
    expect(failedRefs).toContain('nonexistent-memory');
    expect(failedRefs).toContain('other-space:also-nonexistent');
    expect(failedRefs).toContain('invalid-no-colon-ref');

    // Each failed link should have a reason
    for (const failed of res.links_failed) {
      expect(failed.reason).toBeDefined();
      expect(failed.reason.length).toBeGreaterThan(0);
    }

    // Verify the valid link actually exists in the store
    const newMem = store.getMemory('projects/test-repo', 'new-memory');
    expect(newMem).toBeDefined();
    const links = store.getLinks(newMem!.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.target_id).toBe(store.getMemory('projects/test-repo', 'valid-memory')!.id);
  });

  // ==========================================================================
  // Test 3: search removal verification
  // ==========================================================================
  test('search tool is no longer available', async () => {
    // This tests at the tools object level - search should not exist
    const memoryTools = createMemoryTools(store);

    // Verify there's no 'search' tool in the memory tools
    expect((memoryTools as any).search).toBeUndefined();

    // Also verify memory_query exists and accepts search parameter
    expect(typeof memoryTools.memory_query).toBe('object');
    expect(typeof memoryTools.memory_query.handler).toBe('function');

    // The search functionality is now accessed via memory_query with search parameter
  });

  // ==========================================================================
  // Test 4: memory_query with search parameter
  // ==========================================================================
  test('memory_query with search parameter returns unified-pipeline results', async () => {
    process.env.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE = 'true';
    const memoryTools = createMemoryTools(store);

    // 1. Add memory with known content
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'unique-content-memory',
      content: 'This has supercalifragilisticexpialidocious content that is unique',
      tags: ['cat:discovery'],
    });

    // Add another memory with different content
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'other-memory',
      content: 'Different content here',
      tags: ['cat:pattern'],
    });

    // 2. Call memory_query with search="supercalifragilisticexpialidocious"
    const res = await memoryTools.memory_query.handler({
      space: 'projects/test-repo',
      search: 'supercalifragilisticexpialidocious',
    });

    // 3. Verify results contain the memory
    expect(res.memories).toBeDefined();
    expect(Array.isArray(res.memories)).toBe(true);
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.memories.some((m: any) => m.name === 'unique-content-memory')).toBe(true);
    expect(res.memories.some((m: any) => m.name === 'other-memory')).toBe(false);

    // 4. Verify search_method compat mapping: exact token + substring hits => 'mixed'
    expect(res.search_method).toBe('mixed');
  });

  // ==========================================================================
  // Test 5: checkpoint_query with filters
  // ==========================================================================
  test('checkpoint_query with all filters works', async () => {
    const checkpointTools = createCheckpointTools(store);

    // 1. Create multiple checkpoints
    await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'First checkpoint',
    });

    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));

    await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Second checkpoint',
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Third checkpoint',
    });

    // Query without filters - should get all (only active ones)
    const allActive = await checkpointTools.checkpoint_query.handler({
      space: 'projects/test-repo',
    });
    expect(allActive.checkpoints).toBeDefined();
    // Only the latest checkpoint should be active (previous ones get overwritten)
    expect(allActive.checkpoints.length).toBe(1);

    // Query with limit
    const withLimit = await checkpointTools.checkpoint_query.handler({
      space: 'projects/test-repo',
      limit: 10,
    });
    expect(withLimit.limit).toBe(10);
    expect(withLimit.checkpoints.length).toBeLessThanOrEqual(10);

    // Query with offset
    const withOffset = await checkpointTools.checkpoint_query.handler({
      space: 'projects/test-repo',
      offset: 0,
    });
    expect(withOffset.offset).toBe(0);
  });

  // ==========================================================================
  // Test 6: checkpoint_done idempotency
  // ==========================================================================
  test('checkpoint_done second call fails with no active checkpoint', async () => {
    const checkpointTools = createCheckpointTools(store);

    // 1. Create checkpoint
    const created = await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Goal to complete',
    });
    const checkpointName = created.checkpoint!.name;

    // 2. Call checkpoint_done
    await checkpointTools.checkpoint_done.handler({
      space: 'projects/test-repo',
      checkpointName: checkpointName,
      summary: 'Work done',
    });

    // 3. Call checkpoint_done again
    // Should fail with "No active checkpoint found" or "not found"
    await expect(
      checkpointTools.checkpoint_done.handler({
        space: 'projects/test-repo',
      })
    ).rejects.toThrow(/no active checkpoint|not found/i);
  });

  // ==========================================================================
  // Additional integration: Verify memory_query without search returns tier-filtered results
  // ==========================================================================
  test('memory_query without search returns metadata-filtered results', async () => {
    const memoryTools = createMemoryTools(store);

    // Add memories in different tiers
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'tier1-memory',
      content: 'T1 content',
      tags: ['cat:decision'],
      tier: 1,
    });

    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'tier2-memory',
      content: 'T2 content',
      tags: ['cat:pattern'],
      tier: 2,
    });

    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'tier3-memory',
      content: 'T3 content',
      tags: ['cat:discovery'],
      tier: 3,
    });

    // Query all
    const allMemories = await memoryTools.memory_query.handler({
      space: 'projects/test-repo',
    });
    expect(allMemories.memories.length).toBe(3);

    // Query by tier
    const tier1Only = await memoryTools.memory_query.handler({
      space: 'projects/test-repo',
      tier: 1,
    });
    expect(tier1Only.memories.length).toBe(1);
    expect(tier1Only.memories[0].name).toBe('tier1-memory');

    // Query by tag
    const patternOnly = await memoryTools.memory_query.handler({
      space: 'projects/test-repo',
      tag: 'cat:pattern',
    });
    expect(patternOnly.memories.length).toBe(1);
    expect(patternOnly.memories[0].name).toBe('tier2-memory');
  });

  // ==========================================================================
  // Integration: checkpoint_save with linked_memories creates links
  // ==========================================================================
  test('checkpoint_save with linked_memories links memories to checkpoint', async () => {
    const checkpointTools = createCheckpointTools(store);
    const memoryTools = createMemoryTools(store);

    // Create a memory
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'related-memory',
      content: 'Related content',
      tags: ['cat:pattern'],
    });

    // Create checkpoint with linked_memories
    const created = await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Checkpoint with related refs',
      linked_memories: ['related-memory'],
    });

    expect(created.checkpoint).toBeDefined();

    // Verify the checkpoint has a link to the related memory
    const checkpointMem = store.getMemory('projects/test-repo', created.checkpoint!.name);
    expect(checkpointMem).toBeDefined();
    const links = store.getLinks(checkpointMem!.id);
    expect(links.length).toBe(1);

    const relatedMem = store.getMemory('projects/test-repo', 'related-memory');
    expect(links[0]!.target_id).toBe(relatedMem!.id);
    expect(links[0]!.label).toBe('related');
  });

  // ==========================================================================
  // Integration: memory_read returns proper tier_change info
  // ==========================================================================
  test('memory_read returns correct tier_change information', async () => {
    const memoryTools = createMemoryTools(store);

    // Create T2 memory
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'warm-memory',
      content: 'Warm content',
      tags: ['cat:decision'],
      tier: 2,
    });

    const memBefore = store.getMemory('projects/test-repo', 'warm-memory')!;
    expect(memBefore.tier).toBe(2);

    // Read it (should promote to T1)
    const res = await memoryTools.memory_read.handler({
      space: 'projects/test-repo',
      name: 'warm-memory',
    });

    expect(res.tier_change).toBeDefined();
    expect(res.tier_change!.from).toBe(2);
    expect(res.tier_change!.to).toBe(1);
    expect(res.tier_change!.reason).toBe('auto-promote on read');
  });

  // ==========================================================================
  // Integration: session memory preserves links from checkpoint
  // ==========================================================================
  test('checkpoint_done preserves links from checkpoint in session memory', async () => {
    const checkpointTools = createCheckpointTools(store);
    const memoryTools = createMemoryTools(store);

    // Create related memory
    await memoryTools.memory_add.handler({
      space: 'projects/test-repo',
      name: 'base-memory',
      content: 'Base content',
      tags: ['cat:pattern'],
    });

    // Create checkpoint with linked_memories
    const created = await checkpointTools.checkpoint_save.handler({
      space: 'projects/test-repo',
      goal: 'Goal with linked context',
      linked_memories: ['base-memory'],
    });

    // Complete the checkpoint
    const done = await checkpointTools.checkpoint_done.handler({
      space: 'projects/test-repo',
      checkpointName: created.checkpoint!.name,
      summary: 'Work completed',
    });

    // Session memory should have link to the related memory
    const sessionMem = store.getMemory('projects/test-repo', done.session_memory!.name);
    expect(sessionMem).toBeDefined();
    const sessionLinks = store.getLinks(sessionMem!.id);

    // The session memory should have a link to base-memory
    expect(sessionLinks.length).toBe(1);
    const baseMem = store.getMemory('projects/test-repo', 'base-memory');
    expect(sessionLinks[0]!.target_id).toBe(baseMem!.id);
  });
});
