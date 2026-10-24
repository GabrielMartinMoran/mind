import { describe, expect, test } from 'bun:test';

import * as queryMemoriesModule from '../src/mcp/handlers/memories/query-memories';
import { applyCheckpointFilters } from '../src/mcp/helpers/checkpoint-query';
import { normalizeDateBound } from '../src/store/shared/datetime-helpers';
import type { MemorySummary } from '../src/types';

// The store path compares `changed_at` textually against a normalized bound.
// Reproduce that decision here so the MCP filter and the store path can be
// asserted against the exact same fixtures and bounds.
function storeFilter(memories: MemorySummary[], from?: string, to?: string): MemorySummary[] {
  const fromBound = from ? normalizeDateBound(from, false) : null;
  const toBound = to ? normalizeDateBound(to, true) : null;

  return memories.filter(memory => {
    if (fromBound !== null && memory.changed_at < fromBound) {
      return false;
    }
    if (toBound !== null && memory.changed_at > toBound) {
      return false;
    }
    return true;
  });
}

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
      expect(names(storeFilter(boundFixtures, undefined, to))).toEqual([...expected]);
    });
  }

  test('the MCP filter and the store path agree on every bound spelling', () => {
    for (const { to } of cases) {
      expect(names(checkpointFilter(boundFixtures, undefined, to))).toEqual(
        names(storeFilter(boundFixtures, undefined, to))
      );
      expect(names(memoryQueryFilter(boundFixtures, undefined, to))).toEqual(
        names(storeFilter(boundFixtures, undefined, to))
      );
    }
  });
});
