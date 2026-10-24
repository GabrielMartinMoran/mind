import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import * as queryMemoriesModule from '../src/mcp/handlers/memories/query-memories';
import { applyCheckpointFilters } from '../src/mcp/helpers/checkpoint-query';
import { filterByDateRange } from '../src/mcp/helpers/date-filter';
import type { MemorySummary } from '../src/types';

import { createTestStore } from './mocks/test-store';

// The memory_query filter is exported so both call sites can be asserted against
// the exact same boundary cases. It must never diverge from checkpoint_query.
const applyMemoryDateFilters = (
  queryMemoriesModule as unknown as {
    applyDateFilters?: (results: MemorySummary[], from?: string, to?: string) => MemorySummary[];
  }
).applyDateFilters;

function summary(name: string, changedAt: string): MemorySummary {
  return {
    id: name,
    space_name: 'projects/test',
    space_id: 'space-id',
    name,
    tier: 2,
    pinned: false,
    tags: ['checkpoint'],
    access_count: 0,
    created_at: changedAt,
    updated_at: changedAt,
    changed_at: changedAt,
  };
}

function names(memories: MemorySummary[]): string[] {
  return memories.map(memory => memory.name).sort();
}

function thrownMessage(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

function checkpointFilter(memories: MemorySummary[], from?: string, to?: string): MemorySummary[] {
  return applyCheckpointFilters(memories, undefined, undefined, from, to);
}

function memoryQueryFilter(memories: MemorySummary[], from?: string, to?: string): MemorySummary[] {
  expect(applyMemoryDateFilters).toBeFunction();
  return applyMemoryDateFilters!(memories, from, to);
}

describe('date-range filters treat zone-less timestamps as UTC', () => {
  const dayFixtures = [
    summary('before', '2026-10-23 23:59:59'),
    summary('start', '2026-10-24 00:00:00'),
    summary('noon', '2026-10-24 12:00:00'),
    summary('end', '2026-10-24 23:59:59'),
    summary('after', '2026-10-25 00:00:00'),
  ];

  test('date-only from and to cover the full UTC day', () => {
    expect(names(checkpointFilter(dayFixtures, '2026-10-24', '2026-10-24'))).toEqual([
      'end',
      'noon',
      'start',
    ]);
    expect(names(memoryQueryFilter(dayFixtures, '2026-10-24', '2026-10-24'))).toEqual([
      'end',
      'noon',
      'start',
    ]);
  });

  test('date-only from starts at UTC midnight', () => {
    expect(names(checkpointFilter(dayFixtures, '2026-10-24'))).toEqual([
      'after',
      'end',
      'noon',
      'start',
    ]);
    expect(names(memoryQueryFilter(dayFixtures, '2026-10-24'))).toEqual([
      'after',
      'end',
      'noon',
      'start',
    ]);
  });

  test('a to bound that carries a time is honored exactly as UTC', () => {
    const fixtures = [
      summary('at-bound', '2026-10-24 12:00:00'),
      summary('after-bound', '2026-10-24 12:00:01'),
    ];
    expect(names(checkpointFilter(fixtures, undefined, '2026-10-24 12:00:00'))).toEqual([
      'at-bound',
    ]);
    expect(names(memoryQueryFilter(fixtures, undefined, '2026-10-24 12:00:00'))).toEqual([
      'at-bound',
    ]);
  });
});

describe('bound spellings resolve to the same UTC instant on every surface', () => {
  const boundFixtures = [
    summary('just-before', '2026-10-24 09:59:59'),
    summary('lower-edge', '2026-10-24 10:00:00'),
    summary('mid', '2026-10-24 11:00:00'),
    summary('upper-edge', '2026-10-24 12:00:00'),
    summary('just-after', '2026-10-24 12:00:01'),
  ];

  // Each case has a `to` bound and the exact set of fixture names it may keep.
  const cases = [
    {
      label: 'zone-less ISO T bound',
      to: '2026-10-24T12:00:00',
      expected: ['just-before', 'lower-edge', 'mid', 'upper-edge'],
    },
    {
      label: 'space separator with explicit offset',
      to: '2026-10-24 12:00:00+02:00',
      expected: ['just-before', 'lower-edge'],
    },
    {
      label: 'explicit Z bound',
      to: '2026-10-24T12:00:00Z',
      expected: ['just-before', 'lower-edge', 'mid', 'upper-edge'],
    },
  ] as const;

  for (const { label, to, expected } of cases) {
    test(`${label} keeps only rows at or before the UTC instant`, () => {
      expect(names(checkpointFilter(boundFixtures, undefined, to))).toEqual([...expected]);
      expect(names(memoryQueryFilter(boundFixtures, undefined, to))).toEqual([...expected]);
    });
  }
});

describe('invalid date bounds throw the same error on every path', () => {
  const fixtures = [summary('one', '2026-10-24 12:00:00')];

  const invalidBounds = [
    { label: 'from', from: 'not-a-date', to: undefined },
    { label: 'to', from: undefined, to: 'not-a-date' },
  ] as const;

  for (const { label, from, to } of invalidBounds) {
    test(`an invalid ${label} bound throws on every in-memory filter`, () => {
      expect(() => filterByDateRange(fixtures, from, to)).toThrow('Invalid date value: not-a-date');
      expect(() => checkpointFilter(fixtures, from, to)).toThrow('Invalid date value: not-a-date');
      expect(() => memoryQueryFilter(fixtures, from, to)).toThrow('Invalid date value: not-a-date');
    });
  }

  test('the store query and MCP filter throw the same message', () => {
    const testStore = createTestStore();
    try {
      testStore.createSpace('projects/test', 'A test space', ['test']);

      for (const { from, to } of invalidBounds) {
        expect(
          thrownMessage(() => testStore.queryMemories({ space: 'projects/test', from, to }))
        ).toBe('Invalid date value: not-a-date');
        expect(thrownMessage(() => filterByDateRange(fixtures, from, to))).toBe(
          'Invalid date value: not-a-date'
        );
      }
    } finally {
      testStore.cleanup();
    }
  });
});

// The store SQL path and the MCP filter are separate implementations, so this
// suite runs both against one real SQLite store. `changed_at` is written at
// second precision in production; the SQL updates below reproduce that shape.
describe('store query and MCP date filter return identical rows (real store)', () => {
  let store: ReturnType<typeof createTestStore> | undefined;

  afterEach(() => {
    store?.cleanup();
    store = undefined;
  });

  const rows = [
    ['before-day', '2026-10-23 23:59:59'],
    ['start', '2026-10-24 00:00:00'],
    ['at-120000', '2026-10-24 12:00:00'],
    ['at-120001', '2026-10-24 12:00:01'],
    ['end', '2026-10-24 23:59:59'],
    ['after-day', '2026-10-25 00:00:00'],
  ] as const;

  async function seed(): Promise<void> {
    const testStore = createTestStore();
    store = testStore;
    testStore.createSpace('projects/test', 'A test space', ['test']);
    for (const [name] of rows) {
      await testStore.addMemory('projects/test', name, `content ${name}`, {
        tags: ['checkpoint'],
      });
    }

    // Force deterministic `changed_at` values through SQL. `getStatus()` exposes
    // the real store's database path, so this edits the same rows the store reads.
    const db = new Database(testStore.getStatus().db_path);
    try {
      for (const [name, changedAt] of rows) {
        db.run('UPDATE memories SET changed_at = ? WHERE name = ?', [changedAt, name]);
      }
    } finally {
      db.close();
    }
  }

  function queryStore(from?: string, to?: string): string[] {
    return store!
      .queryMemories({ space: 'projects/test', from, to, limit: 500 })
      .map(memory => memory.name)
      .sort();
  }

  function queryMcp(from?: string, to?: string): string[] {
    // memory_query fetches rows first, then filters them in JavaScript.
    const all = store!.queryMemories({ space: 'projects/test', limit: 500 });
    return filterByDateRange(all, from, to)
      .map(memory => memory.name)
      .sort();
  }

  const cases: Array<{
    label: string;
    from?: string;
    to?: string;
    expected: string[];
  }> = [
    {
      label: 'date-only bounds',
      from: '2026-10-24',
      to: '2026-10-24',
      expected: ['at-120000', 'at-120001', 'end', 'start'],
    },
    {
      label: 'zone-less T bound',
      from: '2026-10-24T12:00:00',
      expected: ['after-day', 'at-120000', 'at-120001', 'end'],
    },
    {
      label: 'space separator with explicit offset',
      from: '2026-10-24 14:00:00+02:00',
      expected: ['after-day', 'at-120000', 'at-120001', 'end'],
    },
    {
      label: 'fractional-second from bound',
      from: '2026-10-24 12:00:00.500',
      expected: ['after-day', 'at-120000', 'at-120001', 'end'],
    },
    {
      label: 'fractional-second to bound',
      to: '2026-10-24T12:00:00.001',
      expected: ['at-120000', 'before-day', 'start'],
    },
    {
      label: 'fractional-second to bound at .500',
      to: '2026-10-24 12:00:00.500',
      expected: ['at-120000', 'before-day', 'start'],
    },
  ];

  for (const { label, from, to, expected } of cases) {
    test(`${label} agrees between the store and the MCP filter`, async () => {
      await seed();
      expect(queryStore(from, to)).toEqual([...expected]);
      expect(queryMcp(from, to)).toEqual([...expected]);
      expect(queryMcp(from, to)).toEqual(queryStore(from, to));
    });
  }
});
