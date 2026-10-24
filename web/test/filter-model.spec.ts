import { describe, expect, test } from 'bun:test';

import {
  ALL_TIERS,
  clearFilters,
  hasActiveFilters,
  normalizeTiers,
  tierParams,
  toListQuery,
  toSearchRequest,
} from '../src/domain/filter-model.js';

describe('filter model — tiers', () => {
  test('exposes the canonical all-tiers set', () => {
    expect(ALL_TIERS).toEqual([1, 2, 3]);
  });

  test('normalizes, de-duplicates and orders tiers', () => {
    expect(normalizeTiers('1,1,9,3')).toEqual([1, 3]);
    expect(normalizeTiers([3, 2, 2])).toEqual([2, 3]);
    expect(normalizeTiers([1, 2, 3])).toEqual([1, 2, 3]);
    expect(normalizeTiers('2')).toEqual([2]);
  });

  test('drops empty and invalid input to the all-tiers sentinel', () => {
    expect(normalizeTiers('')).toEqual([]);
    expect(normalizeTiers([9, 'nope', null])).toEqual([]);
    expect(normalizeTiers(undefined)).toEqual([]);
  });
});

describe('filter model — serialization', () => {
  test('keeps the single-tier contract and uses tiers for multiple', () => {
    expect(tierParams([2])).toEqual({ tier: '2' });
    expect(tierParams([1, 3])).toEqual({ tiers: '1,3' });
  });

  test('omits both params for all or empty selections', () => {
    expect(tierParams([1, 2, 3])).toEqual({});
    expect(tierParams([])).toEqual({});
    expect(tierParams([9])).toEqual({});
  });
});

describe('filter model — state', () => {
  test('clearFilters returns the documented defaults', () => {
    expect(clearFilters()).toEqual({
      q: '',
      tag: '',
      tiers: [1, 2, 3],
      confidence: '',
      semantic: false,
      onlyMatches: false,
    });
  });

  test('hasActiveFilters is false only for cleared defaults', () => {
    expect(hasActiveFilters(clearFilters())).toBe(false);
    expect(hasActiveFilters({ ...clearFilters(), tiers: [] })).toBe(false);
    expect(hasActiveFilters({ ...clearFilters(), q: 'auth' })).toBe(true);
    expect(hasActiveFilters({ ...clearFilters(), tag: 'cat:decision' })).toBe(true);
    expect(hasActiveFilters({ ...clearFilters(), tiers: [1, 3] })).toBe(true);
    expect(hasActiveFilters({ ...clearFilters(), confidence: 'high' })).toBe(true);
    expect(hasActiveFilters({ ...clearFilters(), semantic: true })).toBe(true);
    expect(hasActiveFilters({ ...clearFilters(), onlyMatches: true })).toBe(true);
  });
});

describe('filter model — request params', () => {
  test('toListQuery carries tag and tier params', () => {
    expect(toListQuery({ ...clearFilters(), tag: 'a', tiers: [1, 3] })).toEqual({
      tag: 'a',
      tiers: '1,3',
    });
    expect(toListQuery({ ...clearFilters(), tag: '' })).toEqual({});
  });

  test('toSearchRequest carries query, filters and explicit semantic', () => {
    expect(
      toSearchRequest({
        ...clearFilters(),
        q: 'auth',
        tag: 'cat:decision',
        tiers: [2],
        confidence: 'high',
        semantic: true,
      })
    ).toEqual({
      q: 'auth',
      tag: 'cat:decision',
      tier: '2',
      confidence: 'high',
      semantic: 'on',
    });

    expect(toSearchRequest(clearFilters())).toEqual({ q: '', semantic: 'off' });
  });
});
