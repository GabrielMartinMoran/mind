// E-RAG pure helper tests (no server, no DB, no network).

import { describe, expect, test } from 'bun:test';

import {
  attributeEvidence,
  displacement,
  estimateCostUsd,
  latencyStats,
  paidStats,
  setDiff,
  type RankedItem,
} from './ragdiff';

function item(name: string, confidence = 'medium', methods: string[] = ['any']): RankedItem {
  return { name, content: `content-${name}`, score: 0.5, confidence, methods };
}

describe('setDiff', () => {
  test('splits intersection and each side, preserving rank order', () => {
    const diff = setDiff(['A', 'B', 'C'], ['C', 'B', 'D'], 3);
    expect(diff.intersection).toEqual(['B', 'C']);
    expect(diff.offOnly).toEqual(['A']);
    expect(diff.onOnly).toEqual(['D']);
    expect(diff.jaccard).toBeCloseTo(2 / 4, 10);
  });

  test('respects the K window and dedupes repeated names', () => {
    const diff = setDiff(['A', 'A', 'B', 'C'], ['B', 'X'], 2);
    expect(diff.offOnly).toEqual(['A']);
    expect(diff.onOnly).toEqual(['X']);
    expect(diff.jaccard).toBeCloseTo(1 / 3, 10);
  });

  test('two empty windows are a perfect match by convention', () => {
    expect(setDiff([], [], 10)).toEqual({
      intersection: [],
      offOnly: [],
      onOnly: [],
      jaccard: 1,
    });
  });
});

describe('attributeEvidence', () => {
  test('classifies gold into both / lexical-only / semantic-only / neither', () => {
    const attribution = attributeEvidence(['A', 'B'], ['B', 'C'], ['A', 'B', 'C', 'D'], 10);
    expect(attribution.both).toEqual(['B']);
    expect(attribution.lexical_only).toEqual(['A']);
    expect(attribution.semantic_only).toEqual(['C']);
    expect(attribution.neither).toEqual(['D']);
  });

  test('K is applied to both windows', () => {
    const attribution = attributeEvidence(['A', 'B'], ['B', 'C'], ['A', 'B', 'C'], 1);
    expect(attribution.both).toEqual([]);
    expect(attribution.lexical_only).toEqual(['A']);
    expect(attribution.semantic_only).toEqual(['B']);
    expect(attribution.neither).toEqual(['C']);
  });
});

describe('displacement', () => {
  const off = [item('G', 'high', ['all']), item('N', 'high', ['any']), item('L', 'low')];
  const on = [item('N', 'high', ['any']), item('S', 'medium', ['semantic']), item('T', 'low')];

  test('labels items pushed out of the top-K and items inserted into it', () => {
    const result = displacement(off, on, ['G'], ['G', 'N', 'L', 'S', 'X'], ['N', 'S'], 3);
    expect(result.displaced.map(entry => entry.name)).toEqual(['G', 'L']);
    expect(result.inserted.map(entry => entry.name)).toEqual(['S', 'T']);
    const gold = result.displaced.find(entry => entry.name === 'G');
    expect(gold?.isGold).toBe(true);
    expect(gold?.offRank).toBe(1);
    expect(gold?.onRank25).toBeNull();
    const reRanked = result.inserted.find(entry => entry.name === 'S');
    expect(reRanked?.offRank25).toBe(4);
    expect(reRanked?.isGold).toBe(false);
  });

  test('counts inserted items the semantic channel actually supported', () => {
    const result = displacement(off, on, [], [], [], 3);
    expect(paidStats(result).insertedWithSemantic).toBe(1);
  });

  test('a smaller ON result set produces no phantom insertions', () => {
    const result = displacement(off, [item('N')], [], [], [], 3);
    expect(result.inserted).toEqual([]);
    expect(result.displaced.map(entry => entry.name)).toEqual(['G', 'L']);
  });
});

describe('latencyStats', () => {
  test('reports mean, nearest-rank p50/p95, min and max', () => {
    const stats = latencyStats([10, 20, 30, 40, 50]);
    expect(stats.n).toBe(5);
    expect(stats.mean).toBe(30);
    expect(stats.p50).toBe(30);
    expect(stats.p95).toBe(50);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
  });

  test('empty input yields nulls instead of NaN', () => {
    expect(latencyStats([])).toEqual({
      n: 0,
      mean: null,
      p50: null,
      p95: null,
      min: null,
      max: null,
    });
  });
});

describe('cost', () => {
  test('converts measured tokens at a per-million price', () => {
    expect(estimateCostUsd(1800, 0.02)).toBeCloseTo(0.000036, 12);
  });
});
