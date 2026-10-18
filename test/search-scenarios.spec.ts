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
import { stableHash, stableStringify } from './search-eval/hash';
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

// ── Cross-runtime snapshot canonicalization (comparison only) ──
//
// The fused `score` is derived from FTS5 bm25 `rank`, whose last ULP depends on
// the bundled SQLite version (Bun 1.3.14 → SQLite 3.53.0 vs Bun 1.4.3 → SQLite
// 3.53.4). Every other recorded field — result order, `methods`, `confidence`,
// and all metrics — is exact across runtimes. To keep the optimized-baseline
// stability gate meaningful without weakening it, only `score` fields are
// rounded (to 10 decimal places, which is byte-stable across both runtimes)
// before comparison. This never mutates the snapshot stored by the builder.

/** Decimal places used to canonicalize fused `score` fields for comparison. */
const SCORE_CANONICAL_DP = 10;

function roundToDecimalPlaces(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** Recursively round every `score` field to `SCORE_CANONICAL_DP` decimal places. */
function canonicalizeScores(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeScores);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const entry = source[key];
      out[key] =
        key === 'score' && typeof entry === 'number'
          ? roundToDecimalPlaces(entry, SCORE_CANONICAL_DP)
          : canonicalizeScores(entry);
    }
    return out;
  }
  return value;
}

/**
 * Strip the runtime-dependent raw `hash` (and `schema`) so two snapshots can be
 * compared canonically. The remaining shape mirrors the builder's hashed core.
 */
function snapshotCore(snapshot: FixtureSnapshotV2): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'schema' || key === 'hash') continue;
    core[key] = value;
  }
  return core;
}

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

    // Integrity: the committed optimized baseline must be byte-for-byte the
    // pinned content. `baseline.hash` is the stable hash of the raw (unrounded)
    // core, so recomputing it from the loaded file proves the file was not
    // edited to accommodate a ranking change.
    expect(baseline.hash).toBe('4494b323dce79e410f768f87ff54d0bd306a29c7525387dc0c5a3b87f8e38419');
    expect(stableHash(snapshotCore(baseline))).toBe(baseline.hash);

    // Cross-runtime stability: FTS5 bm25 `rank` differs at the last ULP between
    // bundled SQLite versions, so the fused `score` is not byte-stable. Compare
    // everything (result order, topk, methods, confidence, all metrics) via a
    // canonicalized deep equality + canonical hash; only `score` is rounded.
    const currentCanonical = canonicalizeScores(snapshotCore(current.snapshot));
    const baselineCanonical = canonicalizeScores(snapshotCore(baseline));
    expect(stableStringify(currentCanonical)).toBe(stableStringify(baselineCanonical));
    expect(stableHash(currentCanonical)).toBe(stableHash(baselineCanonical));
  });
});
