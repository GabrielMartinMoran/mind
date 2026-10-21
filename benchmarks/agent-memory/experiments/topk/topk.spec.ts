// Experiment C — pure helper tests (no server, no DB).

import { describe, expect, test } from 'bun:test';

import {
  contentHalves,
  entityContentQueries,
  evaluateRanking,
  expandNeighbors,
  interleaveLists,
  matchedWithin,
  neighborNames,
  parseTurnName,
  summarize,
  tokensPerFullPoint,
  type RankedMemory,
} from './topk';

function memory(name: string, content = `c-${name}`): RankedMemory {
  return { name, content };
}

describe('interleaveLists', () => {
  test('alternates lists round-robin instead of exhausting the first', () => {
    const out = interleaveLists(
      [
        [memory('A'), memory('B'), memory('C')],
        [memory('X'), memory('Y')],
      ],
      4
    );
    expect(out.map(item => item.name)).toEqual(['A', 'X', 'B', 'Y']);
  });

  test('dedupes across lists while keeping the earliest position', () => {
    const out = interleaveLists(
      [
        [memory('A'), memory('B')],
        [memory('B'), memory('C')],
      ],
      10
    );
    expect(out.map(item => item.name)).toEqual(['A', 'B', 'C']);
  });

  test('caps at the combined budget and tolerates an empty list', () => {
    expect(interleaveLists([[memory('A'), memory('B')], []], 1).map(item => item.name)).toEqual([
      'A',
    ]);
  });
});

describe('contentHalves', () => {
  test('splits content words into two contiguous complementary queries', () => {
    expect(contentHalves('What did Melanie paint during the pottery break?')).toEqual([
      'What Melanie paint',
      'pottery break?',
    ]);
  });

  test('single content token stays a single query', () => {
    expect(contentHalves('pottery?')).toEqual(['pottery?']);
  });

  test('stopword-only question falls back to the original text', () => {
    expect(contentHalves('the and of')).toEqual(['the and of']);
  });
});

describe('entityContentQueries', () => {
  test('produces an entity-ish and a content-ish query', () => {
    const queries = entityContentQueries('When did Melanie visit New York?', [
      'Melanie',
      'Caroline',
    ]);
    expect(queries).toContain('Melanie New York?');
    expect(queries).toContain('When Melanie visit New York?');
  });

  test('dedupes identical queries', () => {
    expect(entityContentQueries('Melanie?', ['Melanie'])).toEqual(['Melanie?']);
  });
});

describe('session neighbors', () => {
  test('parses D<session>:<turn> names only', () => {
    expect(parseTurnName('D8:12')).toEqual({ session: 'D8', turn: 12 });
    expect(parseTurnName('s8-d8-melanie-12')).toBeNull();
  });

  test('window 1 yields +1 then -1, respecting the session bounds', () => {
    const available = new Set(['D8:1', 'D8:2', 'D8:3']);
    expect(neighborNames('D8:2', 1, available)).toEqual(['D8:3', 'D8:1']);
    expect(neighborNames('D8:1', 1, available)).toEqual(['D8:2']);
  });

  test('window 2 adds +2 and -2 after the adjacent turns', () => {
    const available = new Set(['D8:1', 'D8:2', 'D8:4', 'D8:5']);
    expect(neighborNames('D8:3', 2, available)).toEqual(['D8:4', 'D8:2', 'D8:5', 'D8:1']);
  });
});

describe('expandNeighbors', () => {
  const catalog = new Map<string, string>([
    ['D8:1', 'one'],
    ['D8:2', 'two'],
    ['D8:3', 'three'],
    ['D8:4', 'four'],
    ['D8:5', 'five'],
  ]);

  test('shares the budget between seeds and their neighbors', () => {
    const out = expandNeighbors([{ name: 'D8:2', content: 'two' }], 3, 1, catalog);
    expect(out.map(item => item.name)).toEqual(['D8:2', 'D8:3', 'D8:1']);
  });

  test('never exceeds the budget and never returns a missing neighbor', () => {
    const out = expandNeighbors(
      [
        { name: 'D8:1', content: 'one' },
        { name: 'D8:5', content: 'five' },
      ],
      2,
      2,
      catalog
    );
    expect(out.map(item => item.name)).toEqual(['D8:1', 'D8:2']);
  });

  test('dedupes a neighbor that is also a later seed', () => {
    const out = expandNeighbors(
      [
        { name: 'D8:2', content: 'two' },
        { name: 'D8:3', content: 'three' },
      ],
      10,
      1,
      catalog
    );
    expect(out.map(item => item.name)).toEqual(['D8:2', 'D8:3', 'D8:1', 'D8:4']);
  });
});

describe('evaluateRanking', () => {
  test('any-evidence and all-evidence are distinct', () => {
    const evaluation = evaluateRanking([memory('A'), memory('X'), memory('B')], ['A', 'B'], 10);
    expect(evaluation.any).toBe(true);
    expect(evaluation.full).toBe(true);
    expect(evaluation.matchedWithinK).toBe(2);
  });

  test('full is false when one item falls outside the window', () => {
    const evaluation = evaluateRanking([memory('A'), memory('X'), memory('B')], ['A', 'B'], 2);
    expect(evaluation.any).toBe(true);
    expect(evaluation.full).toBe(false);
    expect(evaluation.recall).toBe(0.5);
  });

  test('gold-less probes keep token cost but null evidence metrics', () => {
    const evaluation = evaluateRanking([memory('A', 'abcd')], [], 10);
    expect(evaluation.tokens).toBe(1);
    expect(evaluation.any).toBe(false);
    expect(evaluation.recall).toBeNull();
  });

  test('matchedWithin counts gold in the first k positions', () => {
    expect(matchedWithin([memory('A'), memory('B')], ['B'], 1)).toBe(0);
    expect(matchedWithin([memory('A'), memory('B')], ['B'], 2)).toBe(1);
  });
});

describe('marginal cost and summaries', () => {
  test('tokensPerFullPoint is null when full evidence does not improve', () => {
    expect(tokensPerFullPoint(100, 0.5, 200, 0.5)).toBeNull();
    expect(tokensPerFullPoint(100, 0.5, 200, 0.6)).toBeCloseTo(10, 10);
  });

  test('summarize excludes gold-less probes from evidence metrics only', () => {
    const summary = summarize([
      evaluateRanking([memory('A')], ['A'], 10, 5),
      evaluateRanking([memory('Z')], [], 10, 7),
    ]);
    expect(summary.probes).toBe(2);
    expect(summary.evidence_count).toBe(1);
    expect(summary.any).toBe(1);
    expect(summary.zero_results).toBe(0);
  });
});
