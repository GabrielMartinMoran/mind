import { describe, expect, test } from 'bun:test';

import {
  presentMemoryDetail,
  presentMemorySummary,
  presentSearchResult,
  presentSpace,
} from '../src/domain/presenters.js';

const INTERNAL_FIELDS = ['embedding', 'fts_id', 'space_id'] as const;

describe('presentSpace', () => {
  test('preserves UI fields', () => {
    const space = {
      name: 'projects/mind',
      description: 'Mind project',
      tags: ['type:project'],
      hidden: false,
      memory_count: 12,
      tier_counts: { t1: 2, t2: 4, t3: 6 },
    };

    expect(presentSpace(space)).toEqual(space);
  });

  test('handles missing optional fields without inventing values', () => {
    expect(presentSpace({ name: 'bare' })).toEqual({ name: 'bare' });
  });
});

describe('presentMemorySummary', () => {
  test('strips internal fields and keeps UI fields', () => {
    const summary = {
      id: 'uuid-1',
      space_name: 'projects/mind',
      space_id: 'space-uuid',
      name: 'mcp-agent-identity',
      tier: 2,
      pinned: true,
      tags: ['cat:decision'],
      access_count: 4,
      embedding: [0.1, 0.2],
      fts_id: 42,
    };

    const presented = presentMemorySummary(summary);

    expect(presented).toEqual({
      id: 'uuid-1',
      space_name: 'projects/mind',
      name: 'mcp-agent-identity',
      tier: 2,
      pinned: true,
      tags: ['cat:decision'],
      access_count: 4,
      tierLabel: 'T2 — Warm',
    });
    for (const field of INTERNAL_FIELDS) {
      expect(presented).not.toHaveProperty(field);
    }
  });
});

describe('presentMemoryDetail', () => {
  test('strips internal fields, keeps content, and derives labels', () => {
    const detail = {
      id: 'uuid-2',
      space_name: 'projects/mind',
      space_id: 'space-uuid',
      name: 'search-pipeline',
      content: '# Search',
      tier: 1,
      pinned: false,
      tags: ['ref:architecture'],
      embedding: new Float32Array([1, 2]),
      fts_id: 7,
      changed_at: '2026-10-21T08:30:00.000Z',
    };

    const presented = presentMemoryDetail(detail);

    expect(presented).toEqual({
      id: 'uuid-2',
      space_name: 'projects/mind',
      name: 'search-pipeline',
      content: '# Search',
      tier: 1,
      pinned: false,
      tags: ['ref:architecture'],
      changed_at: '2026-10-21T08:30:00.000Z',
      tierLabel: 'T1 — Hot',
      changedLabel: '2026-10-21',
    });
    for (const field of INTERNAL_FIELDS) {
      expect(presented).not.toHaveProperty(field);
    }
  });

  test('returns an empty changed label for a missing or invalid timestamp', () => {
    expect(presentMemoryDetail({ name: 'a' }).changedLabel).toBe('');
    expect(presentMemoryDetail({ name: 'a', changed_at: 'not-a-date' }).changedLabel).toBe('');
  });
});

describe('presentSearchResult', () => {
  test('keeps ranking fields and derives human labels', () => {
    const result = {
      id: 'uuid-3',
      space_name: 'projects/mind',
      space_id: 'space-uuid',
      name: 'unified-search',
      content: 'Search',
      tier: 3,
      pinned: false,
      tags: [],
      score: 0.82,
      confidence: 'high',
      methods: ['trigram', 'token_set'],
      embedding: new Float32Array([0]),
      fts_id: 3,
      changed_at: '2026-10-20T23:00:00.000Z',
    };

    const presented = presentSearchResult(result);

    expect(presented).toEqual({
      id: 'uuid-3',
      space_name: 'projects/mind',
      name: 'unified-search',
      content: 'Search',
      tier: 3,
      pinned: false,
      tags: [],
      score: 0.82,
      confidence: 'high',
      methods: ['trigram', 'token_set'],
      changed_at: '2026-10-20T23:00:00.000Z',
      tierLabel: 'T3 — Cold',
      confidenceLabel: 'High confidence',
      methodsLabel: 'Trigram, Token set',
      changedLabel: '2026-10-20',
    });
    for (const field of INTERNAL_FIELDS) {
      expect(presented).not.toHaveProperty(field);
    }
  });

  test('handles absent confidence and methods', () => {
    const presented = presentSearchResult({ name: 'a', tier: 2, space_name: 's' });
    expect(presented.confidenceLabel).toBe('Unknown confidence');
    expect(presented.methodsLabel).toBe('');
    expect(presented.changedLabel).toBe('');
  });
});

describe('presenter input purity', () => {
  test('does not mutate any presenter input', () => {
    const space = { name: 'projects/mind', tags: ['type:project'], hidden: false };
    const summary = { id: 's', name: 'summary', tier: 2, tags: ['cat:pattern'] };
    const detail = {
      id: 'd',
      name: 'detail',
      tier: 1,
      tags: ['ref:architecture'],
      embedding: new Float32Array([1, 2]),
      changed_at: '2026-10-21T08:30:00.000Z',
    };
    const result = {
      id: 'r',
      name: 'result',
      tier: 3,
      tags: [],
      confidence: 'high',
      methods: ['trigram'],
      changed_at: '2026-10-20T23:00:00.000Z',
    };

    const cases = [
      { input: space, present: presentSpace },
      { input: summary, present: presentMemorySummary },
      { input: detail, present: presentMemoryDetail },
      { input: result, present: presentSearchResult },
    ];

    for (const { input, present } of cases) {
      const snapshot = structuredClone(input);
      present(input);
      expect(input).toEqual(snapshot);
    }
  });
});
