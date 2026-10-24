import { describe, expect, test } from 'bun:test';

import {
  filterMemories,
  groupMemoriesByTier,
  paginateMemories,
  sortMemories,
  tierLabel,
} from '../src/domain/memory-model.js';

interface MemoryLike {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  tags?: string[];
  content?: string;
  changed_at?: string;
}

function memory(overrides: Partial<MemoryLike> & Pick<MemoryLike, 'id' | 'name' | 'tier'>) {
  return { tags: [], ...overrides } as MemoryLike;
}

const MEMORIES: MemoryLike[] = [
  memory({ id: '1', name: 'bravo', tier: 2, tags: ['cat:decision'], content: 'Auth flow' }),
  memory({ id: '2', name: 'alpha', tier: 1, tags: ['cat:pattern'], content: 'Graph layout' }),
  memory({ id: '3', name: 'charlie', tier: 2, tags: ['cat:decision'], content: 'Unrelated' }),
  memory({ id: '4', name: 'delta', tier: 3, tags: ['ref:architecture'], content: 'Auth tokens' }),
];

describe('groupMemoriesByTier', () => {
  test('returns stable empty buckets for empty input', () => {
    expect(groupMemoriesByTier([])).toEqual({ 1: [], 2: [], 3: [] });
  });

  test('buckets by tier while preserving input order inside each bucket', () => {
    const grouped = groupMemoriesByTier(MEMORIES);

    expect(grouped[1].map(m => m.name)).toEqual(['alpha']);
    expect(grouped[2].map(m => m.name)).toEqual(['bravo', 'charlie']);
    expect(grouped[3].map(m => m.name)).toEqual(['delta']);
  });
});

describe('filterMemories', () => {
  test('returns an empty array for empty input', () => {
    expect(filterMemories([], {})).toEqual([]);
  });

  test('filters by tier', () => {
    expect(filterMemories(MEMORIES, { tier: 2 }).map(m => m.name)).toEqual(['bravo', 'charlie']);
  });

  test('filters by exact tag, case-insensitively', () => {
    expect(filterMemories(MEMORIES, { tag: 'CAT:DECISION' }).map(m => m.name)).toEqual([
      'bravo',
      'charlie',
    ]);
    expect(filterMemories(MEMORIES, { tag: 'cat' })).toEqual([]);
  });

  test('filters by query across name, tags, and content', () => {
    expect(filterMemories(MEMORIES, { query: 'AUTH' }).map(m => m.name)).toEqual([
      'bravo',
      'delta',
    ]);
    expect(filterMemories(MEMORIES, { query: 'pattern' }).map(m => m.name)).toEqual(['alpha']);
  });

  test('combines filters', () => {
    expect(filterMemories(MEMORIES, { tier: 2, tag: 'cat:decision', query: 'auth' })).toEqual([
      MEMORIES[0],
    ]);
  });

  test('ignores an invalid tier', () => {
    expect(filterMemories(MEMORIES, { tier: 9 as never })).toEqual(MEMORIES);
  });
});

describe('sortMemories', () => {
  test('sorts by name by default and is deterministic', () => {
    expect(sortMemories(MEMORIES).map(m => m.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  test('sorts by tier then name when tier order differs from name and input order', () => {
    const tierOrder: MemoryLike[] = [
      memory({ id: 't1', name: 'zulu', tier: 1 }),
      memory({ id: 't2', name: 'alpha', tier: 3 }),
      memory({ id: 't3', name: 'mike', tier: 2 }),
      memory({ id: 't4', name: 'bravo', tier: 1 }),
    ];

    // Input order: zulu, alpha, mike, bravo — name order: alpha, bravo, mike, zulu.
    expect(sortMemories(tierOrder, { by: 'tier' }).map(m => m.name)).toEqual([
      'bravo',
      'zulu',
      'mike',
      'alpha',
    ]);
  });

  test('does not mutate the input array', () => {
    const copy = [...MEMORIES];
    sortMemories(copy, { by: 'name' });
    expect(copy).toEqual(MEMORIES);
  });

  test('sorts changed memories newest first by valid timestamp', () => {
    const changed: MemoryLike[] = [
      memory({ id: 'c1', name: 'alpha', tier: 1, changed_at: '2026-10-01T00:00:00.000Z' }),
      memory({ id: 'c2', name: 'zulu', tier: 1, changed_at: '2026-10-20T00:00:00.000Z' }),
      memory({ id: 'c3', name: 'mike', tier: 1, changed_at: '2026-10-10T00:00:00.000Z' }),
    ];

    expect(sortMemories(changed, { by: 'changed' }).map(m => m.name)).toEqual([
      'zulu',
      'mike',
      'alpha',
    ]);
  });

  test('sorts invalid and missing timestamps after valid ones deterministically', () => {
    const changed: MemoryLike[] = [
      memory({ id: 'c1', name: 'bravo', tier: 1, changed_at: '2026-10-01T00:00:00.000Z' }),
      memory({ id: 'c2', name: 'alpha', tier: 1, changed_at: 'not-a-date' }),
      memory({ id: 'c3', name: 'delta', tier: 1 }),
      memory({ id: 'c4', name: 'charlie', tier: 1, changed_at: '2026-10-20T00:00:00.000Z' }),
    ];

    const expected = ['charlie', 'bravo', 'alpha', 'delta'];
    expect(sortMemories(changed, { by: 'changed' }).map(m => m.name)).toEqual(expected);
  });

  test('breaks equal changed timestamps by name ascending', () => {
    const timestamp = '2026-10-20T00:00:00.000Z';
    const changed: MemoryLike[] = [
      memory({ id: 'c1', name: 'zulu', tier: 1, changed_at: timestamp }),
      memory({ id: 'c2', name: 'alpha', tier: 1, changed_at: timestamp }),
    ];

    expect(sortMemories(changed, { by: 'changed' }).map(m => m.name)).toEqual(['alpha', 'zulu']);
  });

  test('does not mutate the input when sorting by changed timestamps', () => {
    const changed: MemoryLike[] = [
      memory({ id: 'c1', name: 'alpha', tier: 1, changed_at: '2026-10-01T00:00:00.000Z' }),
      memory({ id: 'c2', name: 'zulu', tier: 1, changed_at: '2026-10-20T00:00:00.000Z' }),
      memory({ id: 'c3', name: 'mike', tier: 1 }),
    ];
    const snapshot = structuredClone(changed);

    sortMemories(changed, { by: 'changed' });

    expect(changed).toEqual(snapshot);
  });
});

describe('paginateMemories', () => {
  test('returns the first page and hasMore', () => {
    expect(paginateMemories(MEMORIES, { limit: 2, offset: 0 })).toEqual({
      items: [MEMORIES[0], MEMORIES[1]],
      total: 4,
      hasMore: true,
    });
  });

  test('returns a final page without more', () => {
    expect(paginateMemories(MEMORIES, { limit: 2, offset: 2 })).toEqual({
      items: [MEMORIES[2], MEMORIES[3]],
      total: 4,
      hasMore: false,
    });
  });

  test('handles an offset past the end and oversized limits', () => {
    expect(paginateMemories(MEMORIES, { limit: 10, offset: 99 })).toEqual({
      items: [],
      total: 4,
      hasMore: false,
    });
    expect(paginateMemories(MEMORIES, { limit: 99, offset: 0 })).toEqual({
      items: MEMORIES,
      total: 4,
      hasMore: false,
    });
  });

  test('applies defaults for empty options', () => {
    const page = paginateMemories(MEMORIES);
    expect(page.total).toBe(4);
    expect(page.items).toEqual(MEMORIES);
    expect(page.hasMore).toBe(false);
  });
});

describe('tierLabel', () => {
  test('labels known tiers', () => {
    expect(tierLabel(1)).toBe('T1 — Hot');
    expect(tierLabel(2)).toBe('T2 — Warm');
    expect(tierLabel(3)).toBe('T3 — Cold');
  });

  test('returns an empty string for an unknown tier', () => {
    expect(tierLabel(9)).toBe('');
    expect(tierLabel(null)).toBe('');
  });
});
