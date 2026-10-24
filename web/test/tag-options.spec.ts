import { describe, expect, test } from 'bun:test';

import { buildTagOptions, normalizeTagOptions } from '../src/domain/tag-options.js';

describe('tag options domain', () => {
  test('normalizes, de-duplicates and alphabetically sorts server tags', () => {
    expect(normalizeTagOptions(['zeta', ' alpha ', 'beta', 'alpha', '', null])).toEqual([
      'alpha',
      'beta',
      'zeta',
    ]);
  });

  test('builds All tags first and then the sorted memory tags', () => {
    const options = buildTagOptions(['status:living', 'cat:decision'], '');

    expect(options.map(option => option.value)).toEqual(['', 'cat:decision', 'status:living']);
    expect(options[0]).toMatchObject({ value: '', label: 'All tags', temporary: false });
    expect(options[1]!.temporary).toBe(false);
  });

  test('an empty server list still offers All tags', () => {
    const options = buildTagOptions([], '');
    expect(options).toEqual([{ value: '', label: 'All tags', temporary: false }]);
  });

  test('preserves a deep-linked tag that is missing from the server list as temporary', () => {
    const options = buildTagOptions(['alpha', 'beta'], 'legacy:tag');

    expect(options.map(option => option.value)).toEqual(['', 'alpha', 'beta', 'legacy:tag']);
    expect(options.at(-1)).toMatchObject({
      value: 'legacy:tag',
      label: 'legacy:tag',
      temporary: true,
    });
  });

  test('does not duplicate a selected tag that the server already returned', () => {
    const options = buildTagOptions(['alpha', 'cat:decision'], 'cat:decision');
    expect(options.map(option => option.value)).toEqual(['', 'alpha', 'cat:decision']);
    expect(options.some(option => option.temporary)).toBe(false);
  });

  test('ignores non-string and blank values without throwing', () => {
    expect(normalizeTagOptions([1, {}, '  ', 'alpha', undefined])).toEqual(['alpha']);
    expect(normalizeTagOptions(null)).toEqual([]);
  });
});
