import { describe, expect, test } from 'bun:test';

import {
  contextTokensAtK,
  estimateTokens,
  evidenceRecallAtK,
  hitAtK,
  mrr,
  precisionAtK,
} from '../src/metrics/retrieval';

describe('estimateTokens', () => {
  test('uses the documented ceil(chars/4) heuristic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('hitAtK', () => {
  test('true only when ALL evidence is within top-k', () => {
    const ranked = ['D1:1', 'D2:2', 'D3:3'];
    expect(hitAtK(ranked, ['D1:1'], 5)).toBe(true);
    expect(hitAtK(ranked, ['D1:1', 'D2:2'], 2)).toBe(true);
    expect(hitAtK(ranked, ['D1:1', 'D3:3'], 2)).toBe(false);
    expect(hitAtK(ranked, ['D3:3'], 2)).toBe(false);
  });

  test('empty evidence is not a hit', () => {
    expect(hitAtK(['D1:1'], [], 5)).toBe(false);
  });
});

describe('evidenceRecallAtK', () => {
  test('fraction of evidence found', () => {
    const ranked = ['a', 'b', 'c', 'd'];
    expect(evidenceRecallAtK(ranked, ['a', 'c'], 4)).toBe(1);
    expect(evidenceRecallAtK(ranked, ['a', 'z'], 4)).toBe(0.5);
    expect(evidenceRecallAtK(ranked, ['a', 'c'], 1)).toBe(0.5);
    expect(evidenceRecallAtK(ranked, ['a'], 0)).toBe(0);
  });

  test('no evidence → null (N/A)', () => {
    expect(evidenceRecallAtK(['a'], [], 5)).toBeNull();
  });
});

describe('mrr', () => {
  test('reciprocal rank of the first evidence item', () => {
    expect(mrr(['a', 'b', 'c'], ['b'], 25)).toBe(0.5);
    expect(mrr(['a', 'b', 'c'], ['a'], 25)).toBe(1);
    expect(mrr(['a', 'b', 'c'], ['c', 'x'], 25)).toBe(1 / 3);
  });

  test('honours maxRank and returns 0 when not found', () => {
    expect(mrr(['a', 'b', 'c'], ['c'], 2)).toBe(0);
    expect(mrr(['a', 'b'], ['z'], 25)).toBe(0);
  });

  test('no evidence → null (N/A)', () => {
    expect(mrr(['a'], [], 25)).toBeNull();
  });
});

describe('precisionAtK', () => {
  test('hits over the returned items up to k', () => {
    expect(precisionAtK(['a', 'b', 'c'], ['a', 'c'], 10)).toBeCloseTo(2 / 3, 10);
    expect(precisionAtK(['a', 'x', 'y', 'b'], ['a', 'b'], 10)).toBe(0.5);
    expect(precisionAtK(['a', 'b'], ['a', 'b'], 1)).toBe(1);
  });

  test('zero results → 0; no evidence → null', () => {
    expect(precisionAtK([], ['a'], 10)).toBe(0);
    expect(precisionAtK(['a'], [], 10)).toBeNull();
  });
});

describe('contextTokensAtK', () => {
  test('sums the estimate over the first k contents', () => {
    const contents = ['a'.repeat(4), 'b'.repeat(8), 'c'.repeat(4)];
    expect(contextTokensAtK(contents, 1)).toBe(1);
    expect(contextTokensAtK(contents, 2)).toBe(3);
    expect(contextTokensAtK(contents, 25)).toBe(4);
  });
});
