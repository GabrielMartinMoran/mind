import { describe, expect, test } from 'bun:test';

import {
  buildSearchRequest,
  formatConfidence,
  formatMethods,
  resultRange,
  semanticEnabled,
} from '../src/domain/search-model.js';

describe('buildSearchRequest', () => {
  test('returns defaults and omits empty filters', () => {
    expect(buildSearchRequest({})).toEqual({
      space: '*',
      semantic: false,
      limit: 30,
      offset: 0,
    });
  });

  test('maps filters from route state', () => {
    expect(
      buildSearchRequest({
        q: '  auth  ',
        spaceFilter: 'projects/mind',
        tag: 'cat:decision',
        tier: 2,
        confidence: 'high',
        semantic: true,
        limit: 10,
        offset: 20,
      })
    ).toEqual({
      q: 'auth',
      space: 'projects/mind',
      tag: 'cat:decision',
      tier: 2,
      confidence: 'high',
      semantic: true,
      limit: 10,
      offset: 20,
    });
  });

  test('ignores invalid tier and confidence values', () => {
    const request = buildSearchRequest({ tier: 9 as never, confidence: 'certain' as never });
    expect(request.tier).toBeUndefined();
    expect(request.confidence).toBeUndefined();
  });

  test('accepts an explicit space field over the filter alias', () => {
    expect(buildSearchRequest({ space: 'projects/test', spaceFilter: 'projects/mind' }).space).toBe(
      'projects/test'
    );
  });
});

describe('formatConfidence', () => {
  test('formats known buckets', () => {
    expect(formatConfidence('high')).toBe('High confidence');
    expect(formatConfidence('medium')).toBe('Medium confidence');
    expect(formatConfidence('low')).toBe('Low confidence');
  });

  test('falls back for unknown values', () => {
    expect(formatConfidence('certain')).toBe('Unknown confidence');
    expect(formatConfidence(undefined)).toBe('Unknown confidence');
  });
});

describe('formatMethods', () => {
  test('maps known methods to human labels', () => {
    expect(formatMethods(['trigram', 'token_set', 'semantic', 'fuzzy'])).toEqual([
      'Trigram',
      'Token set',
      'Semantic',
      'Fuzzy',
    ]);
  });

  test('preserves unknown methods as-is and handles empty input', () => {
    expect(formatMethods(['custom_channel'])).toEqual(['custom_channel']);
    expect(formatMethods([])).toEqual([]);
    expect(formatMethods(undefined)).toEqual([]);
  });
});

describe('resultRange', () => {
  test('computes an inclusive range with hasMore', () => {
    expect(resultRange({ total: 100, limit: 30, offset: 0 })).toEqual({
      from: 1,
      to: 30,
      total: 100,
      hasMore: true,
    });
    expect(resultRange({ total: 100, limit: 30, offset: 90 })).toEqual({
      from: 91,
      to: 100,
      total: 100,
      hasMore: false,
    });
  });

  test('handles empty results', () => {
    expect(resultRange({ total: 0, limit: 30, offset: 0 })).toEqual({
      from: 0,
      to: 0,
      total: 0,
      hasMore: false,
    });
  });
});

describe('semanticEnabled', () => {
  test('is off by default', () => {
    expect(semanticEnabled({}, true)).toBe(false);
    expect(semanticEnabled(undefined, true)).toBe(false);
  });

  test('is on only when the user enabled it and RAG is available', () => {
    expect(semanticEnabled({ semantic: true }, true)).toBe(true);
    expect(semanticEnabled({ semantic: true }, false)).toBe(false);
    expect(semanticEnabled({ semantic: false }, true)).toBe(false);
  });
});
