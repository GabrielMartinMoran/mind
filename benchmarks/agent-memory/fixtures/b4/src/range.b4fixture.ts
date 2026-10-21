import { expect, test } from 'bun:test';

import { isInRange } from './range.ts';

test('bounds are inclusive', () => {
  expect(isInRange(0, 0, 10)).toBe(true);
  expect(isInRange(10, 0, 10)).toBe(true);
  expect(isInRange(5, 0, 10)).toBe(true);
});

test('values outside the bounds are rejected', () => {
  expect(isInRange(-1, 0, 10)).toBe(false);
  expect(isInRange(11, 0, 10)).toBe(false);
});
