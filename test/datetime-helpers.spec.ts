import { describe, expect, test } from 'bun:test';

import { normalizeDateBound } from '../src/store/shared/datetime-helpers';

// `changed_at` is stored as a zone-less UTC string in "YYYY-MM-DD HH:MM:SS"
// form. Date bounds must use the same textual shape so SQL string comparison
// stays correct, and they must resolve identically on every host timezone.
describe('normalizeDateBound', () => {
  test('a date-only from bound starts at UTC midnight', () => {
    expect(normalizeDateBound('2026-10-24', false)).toBe('2026-10-24 00:00:00');
  });

  test('a date-only to bound ends at the last UTC second of the day', () => {
    expect(normalizeDateBound('2026-10-24', true)).toBe('2026-10-24 23:59:59');
  });

  test('a time-bearing bound is preserved and not widened to end of day', () => {
    expect(normalizeDateBound('2026-10-24 12:34:56', false)).toBe('2026-10-24 12:34:56');
    expect(normalizeDateBound('2026-10-24 12:34:56', true)).toBe('2026-10-24 12:34:56');
  });

  test('an ISO UTC bound is converted to the storage text format', () => {
    expect(normalizeDateBound('2026-10-24T12:34:56Z')).toBe('2026-10-24 12:34:56');
  });

  test('an offset-bearing bound is converted to UTC', () => {
    expect(normalizeDateBound('2026-10-24T12:34:56+03:00')).toBe('2026-10-24 09:34:56');
  });

  test('a zone-less ISO T bound is treated as UTC, not host-local time', () => {
    expect(normalizeDateBound('2026-10-24T12:00:00')).toBe('2026-10-24 12:00:00');
    expect(normalizeDateBound('2026-10-24T12:00:00', true)).toBe('2026-10-24 12:00:00');
  });

  test('a space-separated bound with an explicit offset is converted to UTC', () => {
    expect(normalizeDateBound('2026-10-24 12:00:00+02:00')).toBe('2026-10-24 10:00:00');
    expect(normalizeDateBound('2026-10-24 12:00:00-02:00')).toBe('2026-10-24 14:00:00');
  });

  test('an offset without a colon is converted to UTC', () => {
    expect(normalizeDateBound('2026-10-24T12:00:00+0200')).toBe('2026-10-24 10:00:00');
  });

  test('an explicit Z bound is honored as UTC', () => {
    expect(normalizeDateBound('2026-10-24T12:00:00Z')).toBe('2026-10-24 12:00:00');
    expect(normalizeDateBound('2026-10-24 12:00:00Z')).toBe('2026-10-24 12:00:00');
  });

  test('fractional seconds are resolved to whole seconds', () => {
    expect(normalizeDateBound('2026-10-24 12:00:00.500')).toBe('2026-10-24 12:00:00');
    expect(normalizeDateBound('2026-10-24T12:00:00.001')).toBe('2026-10-24 12:00:00');
    expect(normalizeDateBound('2026-10-24T12:00:00.999Z')).toBe('2026-10-24 12:00:00');
    expect(normalizeDateBound('2026-10-24T14:00:00.500+02:00')).toBe('2026-10-24 12:00:00');
  });

  test('a fractional-second time-bearing to bound still floors to its whole second', () => {
    expect(normalizeDateBound('2026-10-24 12:00:00.500', true)).toBe('2026-10-24 12:00:00');
  });

  test('invalid input still throws', () => {
    expect(() => normalizeDateBound('not-a-date')).toThrow('Invalid date value: not-a-date');
  });

  test('returned bounds are lexicographically comparable with changed_at', () => {
    const from = normalizeDateBound('2026-10-24', false);
    const to = normalizeDateBound('2026-10-24', true);
    const changedAt = '2026-10-24 15:00:00';

    expect(from <= changedAt).toBe(true);
    expect(changedAt <= to).toBe(true);
  });
});
