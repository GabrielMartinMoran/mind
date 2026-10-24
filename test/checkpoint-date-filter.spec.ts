import { describe, expect, test } from 'bun:test';

import * as queryMemoriesModule from '../src/mcp/handlers/memories/query-memories';
import { applyCheckpointFilters } from '../src/mcp/helpers/checkpoint-query';
import type { MemorySummary } from '../src/types';

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

  test('checkpoint_query and memory_query return identical results for the same bounds', () => {
    for (const [from, to] of [
      ['2026-10-24', '2026-10-24'],
      ['2026-10-24', undefined],
      [undefined, '2026-10-24 12:00:00'],
    ] as const) {
      expect(names(checkpointFilter(dayFixtures, from, to))).toEqual(
        names(memoryQueryFilter(dayFixtures, from, to))
      );
    }
  });
});
