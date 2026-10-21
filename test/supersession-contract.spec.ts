import { afterEach, describe, expect, test } from 'bun:test';

import { createLinkTools } from '../src/mcp/tools/links';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

const SPACE = 'projects/supersession-demo';

afterEach(() => {
  store?.cleanup();
});

function seedSpace() {
  store = createTestStore();
  store.createSpace(SPACE, 'Supersession contract project', ['type:project']);
}

const OLD_CONTENT =
  '**What**: Use stateless JWTs for authentication.\n**Why**: Avoid server-side session storage during horizontal scaling.\n**Where**: src/auth/session.ts';
const NEW_CONTENT =
  '**What**: Use short-lived access tokens with server-side revocation.\n**Why**: Stateless JWTs could not be revoked quickly.\n**Where**: src/auth/session.ts';

describe('decision supersession contract', () => {
  test('preserves the historical memory and records the replacement', async () => {
    seedSpace();
    const memoryTools = createMemoryTools(store);
    const linkTools = createLinkTools(store);

    await memoryTools.memory_add.handler({
      space: SPACE,
      name: 'jwt-over-sessions',
      content: OLD_CONTENT,
      tags: ['cat:decision', 'auth'],
    });

    await memoryTools.memory_add.handler({
      space: SPACE,
      name: 'revocable-access-tokens',
      content: NEW_CONTENT,
      tags: ['cat:decision', 'auth', 'status:validated'],
    });

    await memoryTools.memory_update.handler({
      space: SPACE,
      name: 'jwt-over-sessions',
      tags: ['cat:decision', 'auth', 'status:superseded'],
    });

    await linkTools.link_create.handler({
      sourceRef: `${SPACE}:revocable-access-tokens`,
      targetRef: `${SPACE}:jwt-over-sessions`,
      label: 'contradicts',
    });

    const historical = store.getMemory(SPACE, 'jwt-over-sessions');
    expect(historical).not.toBeNull();
    expect(historical?.content).toBe(OLD_CONTENT);
    expect(historical?.tags).toEqual(
      expect.arrayContaining(['cat:decision', 'auth', 'status:superseded'])
    );
    expect(historical?.tags).not.toContain('status:validated');

    const replacement = store.getMemory(SPACE, 'revocable-access-tokens');
    expect(replacement).not.toBeNull();
    expect(replacement?.content).toBe(NEW_CONTENT);
    expect(replacement?.tags).toContain('cat:decision');

    const links = store.getLinks(replacement!.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.source_id).toBe(replacement!.id);
    expect(links[0]?.target_id).toBe(historical!.id);
    expect(links[0]?.label).toBe('contradicts');

    const names = store.listMemories(SPACE).map(memory => memory.name);
    expect(names).toContain('jwt-over-sessions');
    expect(names).toContain('revocable-access-tokens');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(2);
  });

  test('memory_update preserves tags when omitted and replaces them when provided', async () => {
    seedSpace();
    const memoryTools = createMemoryTools(store);

    await memoryTools.memory_add.handler({
      space: SPACE,
      name: 'decision-record',
      content: 'Original content',
      tags: ['cat:decision', 'auth'],
    });

    await memoryTools.memory_update.handler({
      space: SPACE,
      name: 'decision-record',
      content: 'Revised content',
    });

    const afterContentUpdate = store.getMemory(SPACE, 'decision-record');
    expect([...(afterContentUpdate?.tags ?? [])].sort()).toEqual(['auth', 'cat:decision']);

    await memoryTools.memory_update.handler({
      space: SPACE,
      name: 'decision-record',
      tags: ['status:superseded'],
    });

    const afterTagReplacement = store.getMemory(SPACE, 'decision-record');
    expect(afterTagReplacement?.tags).toEqual(['status:superseded']);
  });

  test('a living reference keeps its identity and source link when its truth changes', async () => {
    seedSpace();
    const memoryTools = createMemoryTools(store);

    await memoryTools.memory_add.handler({
      space: SPACE,
      name: 'jwt-over-sessions',
      content: OLD_CONTENT,
      tags: ['cat:decision', 'auth'],
    });

    await memoryTools.memory_add.handler({
      space: SPACE,
      name: 'architecture-overview',
      content:
        '**Purpose**: Current auth architecture.\n**Current truth**: Authentication uses stateless JWTs.\n**Source memories**: jwt-over-sessions',
      tags: ['type:reference', 'ref:architecture', 'status:living'],
      links_to: [`${SPACE}:jwt-over-sessions`],
    });

    const source = store.getMemory(SPACE, 'jwt-over-sessions')!;
    const reference = store.getMemory(SPACE, 'architecture-overview')!;
    expect(store.getLinks(reference.id)).toEqual([
      expect.objectContaining({ source_id: reference.id, target_id: source.id }),
    ]);

    await memoryTools.memory_update.handler({
      space: SPACE,
      name: 'architecture-overview',
      content:
        '**Purpose**: Current auth architecture.\n**Current truth**: Authentication uses short-lived access tokens with server-side revocation.\n**Source memories**: jwt-over-sessions, revocable-access-tokens',
      tags: ['type:reference', 'ref:architecture', 'status:living'],
    });

    const updated = store.getMemory(SPACE, 'architecture-overview');
    expect(updated?.content).toContain('short-lived access tokens');
    expect([...(updated?.tags ?? [])].sort()).toEqual([
      'ref:architecture',
      'status:living',
      'type:reference',
    ]);
    expect(store.getLinks(reference.id)).toEqual([
      expect.objectContaining({ source_id: reference.id, target_id: source.id }),
    ]);
  });
});
