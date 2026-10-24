import { describe, expect, test } from 'bun:test';

import {
  nodeDegree,
  nodeDegreeFontSize,
  nodeDegreeLabel,
  nodeRadius,
} from '../src/domain/graph-node-metrics.js';

/** Approximate advance width of a digit relative to font-size, mirrored by the metric. */
const DIGIT_WIDTH_RATIO = 0.62;

function textWidth(label: string, fontSize: number): number {
  return label.length * DIGIT_WIDTH_RATIO * fontSize;
}

describe('node degree metrics', () => {
  test('degree sums outgoing and incoming links', () => {
    expect(nodeDegree({ links_to: ['a', 'b'], linked_by: ['c'] })).toBe(3);
    expect(nodeDegree({ links_to: [], linked_by: [] })).toBe(0);
    expect(nodeDegree({ links_to: ['a'], linked_by: ['b', 'c', 'd'] })).toBe(4);
    expect(nodeDegree({})).toBe(0);
    expect(nodeDegree(undefined)).toBe(0);
  });

  test('degree label is a plain non-negative integer string', () => {
    expect(nodeDegreeLabel(0)).toBe('0');
    expect(nodeDegreeLabel(4)).toBe('4');
    expect(nodeDegreeLabel(41)).toBe('41');
    expect(nodeDegreeLabel(3.9)).toBe('3');
    expect(nodeDegreeLabel(-2)).toBe('0');
    expect(nodeDegreeLabel(Number.NaN)).toBe('0');
  });

  test('radius grows monotonically with degree and stays within bounds', () => {
    expect(nodeRadius(0)).toBeGreaterThanOrEqual(8);
    expect(nodeRadius(0)).toBeLessThanOrEqual(9);

    const p90 = nodeRadius(4);
    expect(p90).toBeGreaterThanOrEqual(15);
    expect(p90).toBeLessThanOrEqual(17);

    const capped = nodeRadius(41);
    expect(capped).toBeGreaterThan(p90);
    expect(capped).toBeLessThanOrEqual(22);
    expect(capped).toBeGreaterThanOrEqual(20);

    // Monotonic, and dense graphs stop exploding past the cap.
    let previous = nodeRadius(0);
    for (let degree = 1; degree <= 60; degree += 1) {
      const current = nodeRadius(degree);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(nodeRadius(500)).toBe(nodeRadius(41));
  });

  test('accepts radius overrides while keeping the min/max contract', () => {
    const custom = nodeRadius(16, { min: 6, max: 18, scale: 2 });
    expect(custom).toBeGreaterThanOrEqual(6);
    expect(custom).toBeLessThanOrEqual(18);
  });

  test('degree font size keeps the label inside the circle for 0-3 digits', () => {
    const radii = [nodeRadius(0), nodeRadius(4), nodeRadius(41)];

    for (const radius of radii) {
      for (let digits = 0; digits <= 3; digits += 1) {
        const fontSize = nodeDegreeFontSize(radius, digits);
        expect(fontSize).toBeGreaterThanOrEqual(8);
        expect(fontSize).toBeLessThanOrEqual(13);

        const label = '0'.repeat(Math.max(1, digits));
        expect(textWidth(label, fontSize)).toBeLessThan(radius * 2);
      }
    }
  });

  test('font size shrinks as the number gets longer but never overflows', () => {
    const radius = nodeRadius(0);
    const one = nodeDegreeFontSize(radius, 1);
    const two = nodeDegreeFontSize(radius, 2);
    const three = nodeDegreeFontSize(radius, 3);

    expect(one).toBeGreaterThanOrEqual(two);
    expect(two).toBeGreaterThanOrEqual(three);
    expect(textWidth('999', three)).toBeLessThan(radius * 2);
  });
});
