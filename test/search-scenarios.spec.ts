// ── CI spec for the expanded (v2) search evaluation suite ──
//
// Verifies the v2 taxonomy (per-axis counts), label invariants, unique ids,
// corpus-membership of labels, determinism (two builds and two runs agree), and
// equality against the committed v2 baseline. The v1 suite is covered separately
// by `search-eval.spec.ts` (whose baseline is immutable).
//
// Like the v1 snapshot gate, the v2 baseline is a STABILITY gate: it records the
// current engine's behavior so later optimization tasks cannot silently change
// ranking without a QA-validated baseline update.

import { describe, expect, test } from 'bun:test';

import { buildV2Cases } from './search-eval/cases.expanded';
import { V2_CORPUS } from './search-eval/corpus.expanded';
import { runFixtureV2, type FixtureSnapshotV2 } from './search-eval/evaluator';
import { parseRef, refOf } from './search-eval/refs';
import type { CaseLevel, CaseType } from './search-eval/types';

const LEVELS: CaseLevel[] = ['N0', 'N1', 'N2', 'N3', 'N4'];

/** Axis → minimum number of v2 cases the suite must contain. */
const AXIS_MINIMUMS: Partial<Record<CaseType, number>> = {
  exact: 30,
  identifier: 30,
  substring: 30,
  prefix: 8,
  phrase: 5,
  and: 10,
  or: 4,
  not: 3,
  typo: 5,
  first3typo: 10,
  transposition: 10,
  insertion: 5,
  deletion: 5,
  shorttoken: 3,
  diacritics: 10,
  querylength: 6,
  longmemory: 3,
  frequent: 3,
  bilingual: 6,
  nearDuplicate: 6,
  negative: 8,
  anti_bias: 4,
  neutral: 5,
};

describe('v2 fixture taxonomy', () => {
  const cases = buildV2Cases();

  test('meets total and origin targets', () => {
    expect(cases.length).toBeGreaterThanOrEqual(250);
    const lab = cases.filter(c => c.origin === 'lab').length;
    const emulated = cases.filter(c => c.origin === 'emulated').length;
    expect(lab).toBeGreaterThanOrEqual(200);
    expect(emulated).toBeGreaterThanOrEqual(1);
    expect(lab + emulated).toBe(cases.length);
  });

  test('every difficulty level N0–N4 is present', () => {
    for (const level of LEVELS) {
      expect(cases.some(c => c.level === level)).toBe(true);
    }
  });

  test('each required axis meets its minimum count', () => {
    const counts = new Map<CaseType, number>();
    for (const testCase of cases) {
      counts.set(testCase.type, (counts.get(testCase.type) ?? 0) + 1);
    }
    for (const [type, minimum] of Object.entries(AXIS_MINIMUMS) as [CaseType, number][]) {
      expect(counts.get(type) ?? 0).toBeGreaterThanOrEqual(minimum);
    }
  });

  test('negatives (expected-empty) are present', () => {
    expect(cases.filter(c => c.expected.length === 0).length).toBeGreaterThanOrEqual(8);
    expect(cases.some(c => c.type === 'negative' && c.expected.length === 0)).toBe(true);
  });

  test('label invariant: non-negative cases have labels, negative cases have none', () => {
    const badNonNegative = cases.filter(c => c.type !== 'negative' && c.expected.length === 0);
    const badNegative = cases.filter(c => c.type === 'negative' && c.expected.length !== 0);
    expect(badNonNegative.map(c => c.id)).toEqual([]);
    expect(badNegative.map(c => c.id)).toEqual([]);
  });

  test('ids are unique and non-empty; queries are non-empty', () => {
    const ids = cases.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.length > 0)).toBe(true);
    expect(cases.every(c => c.query.length > 0)).toBe(true);
  });

  test('every label is a well-formed ref inside the v2 corpus', () => {
    const corpusRefs = new Set(V2_CORPUS.map(doc => refOf(doc.space, doc.name)));
    for (const testCase of cases) {
      for (const label of testCase.expected) {
        expect(label.includes('::')).toBe(true);
        expect(corpusRefs.has(label)).toBe(true);
        expect(parseRef(label).name.length).toBeGreaterThan(0);
      }
    }
  });

  test('covers the expanded corpus with multiple spaces', () => {
    expect(new Set(V2_CORPUS.map(doc => doc.space)).size).toBeGreaterThanOrEqual(3);
    const expandedNames = new Set(V2_CORPUS.slice(60).map(doc => doc.name));
    expect(expandedNames.size).toBeGreaterThanOrEqual(30);
  });
});

describe('v2 determinism and baseline stability', () => {
  test('two consecutive builds produce identical cases', () => {
    expect(JSON.stringify(buildV2Cases())).toBe(JSON.stringify(buildV2Cases()));
  });

  test('two consecutive v2 runs produce identical snapshot hashes', async () => {
    const first = await runFixtureV2();
    const second = await runFixtureV2();
    expect(first.snapshot.hash).toBe(second.snapshot.hash);
    expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(second.snapshot));
  });

  test('historical v2 baseline is frozen and immutable', async () => {
    const baselineFile = new URL('./search-eval/baseline.fixture.v2.json', import.meta.url);
    const baseline = (await Bun.file(baselineFile).json()) as FixtureSnapshotV2;
    expect(baseline.schema).toBe('search-eval-baseline/v2');
    expect(baseline.hash).toBe('456778b34f402c3e780bd3946049f77eb12aaec52d24ca236a966446e47ae440');
    expect(baseline.case_count).toBe(298);
    expect(baseline.metrics.overall.passed).toBe(236);
  });

  test('current v2 snapshot equals the optimized baseline', async () => {
    const baselineFile = new URL(
      './search-eval/baseline.fixture.v2.optimized.json',
      import.meta.url
    );
    const baseline = (await Bun.file(baselineFile).json()) as FixtureSnapshotV2;
    const current = await runFixtureV2();
    // Pin the optimized (P-A-only fallback) v2 hash so a silent ranking change
    // cannot pass by editing the file, then prove the live engine matches it.
    expect(baseline.hash).toBe('4494b323dce79e410f768f87ff54d0bd306a29c7525387dc0c5a3b87f8e38419');
    expect(current.snapshot.hash).toBe(baseline.hash);
    expect(JSON.stringify(current.snapshot)).toBe(JSON.stringify(baseline));
  });
});
