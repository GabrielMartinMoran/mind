// ── CI spec for the search evaluation suite ──
//
// Covers: (a) metrics math on synthetic mini-cases, (b) taxonomy targets on the
// fixture cases, (c) determinism (two runs → identical snapshot hash), and
// (d) snapshot stability vs the committed baseline.
//
// The snapshot assertion is a STABILITY gate, not a desired-behavior floor: it
// records the current engine's behavior (which is expected to be poor) so later
// tasks cannot silently change ranking without a QA-validated snapshot update.

import { describe, expect, test } from 'bun:test';

import { buildFixtureCases } from './search-eval/cases';
import { FIXTURE_CORPUS } from './search-eval/corpus';
import { runFixture, type FixtureSnapshot } from './search-eval/evaluator';
import { aggregateVerdicts, computeVerdict, type CaseVerdict } from './search-eval/metrics';
import { computeRankingMetrics, ndcgAtK, reciprocalRank } from './search-eval/ranking-metrics';
import { refOf } from './search-eval/refs';
import { parseRef } from './search-eval/refs';
import type { CaseLevel, EvalCase } from './search-eval/types';

function syntheticCase(overrides: Partial<EvalCase> & { expected: string[] }): EvalCase {
  return {
    id: overrides.id ?? 'syn',
    query: overrides.query ?? 'q',
    params: overrides.params ?? {},
    expected: overrides.expected,
    level: overrides.level ?? 'N1',
    origin: overrides.origin ?? 'lab',
    type: overrides.type ?? 'exact',
  };
}

function verdict(observed: string[], expected: string[], limit?: number): CaseVerdict {
  return computeVerdict(
    observed,
    syntheticCase({ expected, params: limit === undefined ? {} : { limit } })
  );
}

describe('metrics math (synthetic mini-cases)', () => {
  test('mixed hits: tp/fp/fn and P@k/R@k', () => {
    const v = verdict(['s::a', 's::x', 's::b'], ['s::a', 's::b', 's::c']);
    expect(v.tp).toBe(2);
    expect(v.fp).toBe(1);
    expect(v.fn).toBe(1);
    expect(v.precision).toBeCloseTo(2 / 3, 10);
    expect(v.recall).toBeCloseTo(2 / 3, 10);
    expect(v.passed).toBe(false);
  });

  test('perfect single hit passes', () => {
    const v = verdict(['s::a'], ['s::a']);
    expect(v.tp).toBe(1);
    expect(v.fp).toBe(0);
    expect(v.fn).toBe(0);
    expect(v.precision).toBe(1);
    expect(v.recall).toBe(1);
    expect(v.passed).toBe(true);
  });

  test('k truncates the retrieval window', () => {
    const v = verdict(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 2);
    expect(v.k).toBe(2);
    expect(v.topK).toEqual(['a', 'b']);
    expect(v.tp).toBe(2);
    expect(v.fp).toBe(0);
    expect(v.fn).toBe(2);
    expect(v.precision).toBe(1);
    expect(v.recall).toBe(0.5);
    expect(v.passed).toBe(false);
  });

  test('empty retrieval with non-empty labels: precision 0, recall 0', () => {
    const v = verdict([], ['a']);
    expect(v.tp).toBe(0);
    expect(v.fp).toBe(0);
    expect(v.fn).toBe(1);
    expect(v.precision).toBe(0);
    expect(v.recall).toBe(0);
    expect(v.passed).toBe(false);
  });

  test('negative case returning nothing passes, no noise', () => {
    const v = verdict([], []);
    expect(v.precision).toBe(1);
    expect(v.recall).toBe(1);
    expect(v.passed).toBe(true);
    expect(v.noise).toBe(false);
  });

  test('negative case returning results fails and is noise', () => {
    const v = verdict(['s::z'], []);
    expect(v.fp).toBe(1);
    expect(v.precision).toBe(0);
    expect(v.passed).toBe(false);
    expect(v.noise).toBe(true);
  });

  test('duplicate refs are deduped', () => {
    const v = verdict(['a', 'a', 'b'], ['a', 'b']);
    expect(v.tp).toBe(2);
    expect(v.fp).toBe(0);
    expect(v.passed).toBe(true);
  });

  test('aggregation averages precision/recall and sums counts', () => {
    const verdicts = [verdict(['a', 'x', 'b'], ['a', 'b', 'c']), verdict(['a'], ['a'])];
    const metrics = aggregateVerdicts(verdicts);
    expect(metrics.cases).toBe(2);
    expect(metrics.passed).toBe(1);
    expect(metrics.avgPrecision).toBeCloseTo((2 / 3 + 1) / 2, 10);
    expect(metrics.avgRecall).toBeCloseTo((2 / 3 + 1) / 2, 10);
    expect(metrics.tp).toBe(3);
    expect(metrics.fp).toBe(1);
    expect(metrics.fn).toBe(1);
  });

  test('noise-rate is computed over negatives only', () => {
    const metrics = aggregateVerdicts([verdict([], []), verdict(['z'], []), verdict(['a'], ['a'])]);
    expect(metrics.negatives).toBe(2);
    expect(metrics.noiseCases).toBe(1);
    expect(metrics.noiseRate).toBe(0.5);
  });
});

describe('fixture taxonomy', () => {
  const cases = buildFixtureCases();
  const levels: CaseLevel[] = ['N0', 'N1', 'N2', 'N3', 'N4'];

  test('meets total and origin targets', () => {
    expect(cases.length).toBeGreaterThanOrEqual(250);
    const emulated = cases.filter(c => c.origin === 'emulated').length;
    const lab = cases.filter(c => c.origin === 'lab').length;
    const realShape = cases.filter(c => c.realShape === true).length;
    expect(emulated).toBeGreaterThanOrEqual(150);
    expect(realShape).toBeGreaterThanOrEqual(40);
    expect(lab).toBeGreaterThanOrEqual(1);
  });

  test('every difficulty level N0–N4 is present', () => {
    for (const level of levels) {
      expect(cases.some(c => c.level === level)).toBe(true);
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

  test('every case has explicit, well-formed labels inside the corpus', () => {
    const corpusRefs = new Set(FIXTURE_CORPUS.map(doc => refOf(doc.space, doc.name)));
    for (const testCase of cases) {
      expect(testCase.id.length).toBeGreaterThan(0);
      expect(testCase.query.length).toBeGreaterThan(0);
      for (const ref of testCase.expected) {
        expect(ref.includes('::')).toBe(true);
        expect(corpusRefs.has(ref)).toBe(true);
        expect(parseRef(ref).name.length).toBeGreaterThan(0);
      }
    }
  });

  test('covers multiple match types and at least two spaces', () => {
    const types = new Set(cases.map(c => c.type));
    for (const type of ['exact', 'or', 'not', 'typo', 'filter', 'negative', 'identifier']) {
      expect(types.has(type as never)).toBe(true);
    }
    expect(new Set(FIXTURE_CORPUS.map(d => d.space)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('determinism and baseline stability', () => {
  test('two consecutive fixture runs produce identical snapshot hashes', async () => {
    const first = await runFixture();
    const second = await runFixture();
    expect(first.snapshot.hash).toBe(second.snapshot.hash);
    expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(second.snapshot));
  });

  test('optimized v1 snapshot matches the recorded optimized hash (diverges from the frozen v1)', async () => {
    const baselineFile = new URL('./search-eval/baseline.fixture.json', import.meta.url);
    const frozen = (await Bun.file(baselineFile).json()) as FixtureSnapshot;
    const current = await runFixture();
    // The v1 baseline stays immutable (E1); the current engine is the optimized
    // result. Only the v2 optimized result is stored as a file, so the v1
    // optimized hash is pinned here. They differ because R1 (remove_diacritics)
    // changes recall on the v1 fixture.
    expect(frozen.hash).toBe('1f5bf98a5fc2d9c7ab46515cf6cfa250223897c117fc2fe754cebbc40e2c2a52');
    expect(current.snapshot.hash).toBe(
      'de1a2973249a189ef41df1a645a3eb2349e9d1d59713f5f15f56b41b96df59db'
    );
    expect(current.snapshot.hash).not.toBe(frozen.hash);
  });
});

// ── v2 suite (ranking metrics + immutable v1 baseline proof) ──

describe('v1 baseline is immutable', () => {
  test('v1 baseline hash and pass count are unchanged', async () => {
    const baselineFile = new URL('./search-eval/baseline.fixture.json', import.meta.url);
    const baseline = (await Bun.file(baselineFile).json()) as FixtureSnapshot;
    expect(baseline.schema).toBe('search-eval-baseline/v1');
    expect(baseline.hash).toBe('1f5bf98a5fc2d9c7ab46515cf6cfa250223897c117fc2fe754cebbc40e2c2a52');
    expect(baseline.case_count).toBe(297);
    expect(baseline.metrics.overall.passed).toBe(246);
    expect(baseline.metrics.overall.cases).toBe(297);
  });
});

describe('v2 ranking metrics math (synthetic mini-cases)', () => {
  test('reciprocal rank uses the 1-based rank of the first relevant ref', () => {
    expect(reciprocalRank(['a', 'b'], ['b'])).toBe(0.5);
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
    expect(reciprocalRank(['a', 'b'], ['c'])).toBe(0);
    expect(reciprocalRank([], ['a'])).toBe(0);
  });

  test('nDCG@10 is 1 for a perfect top-k', () => {
    expect(ndcgAtK(['a', 'b'], ['a', 'b'], 10)).toBeCloseTo(1, 12);
  });

  test('nDCG@10 discounts a relevant ref at a lower position', () => {
    const atSecond = ndcgAtK(['x', 'a'], ['a'], 10);
    expect(atSecond).toBeCloseTo(1 / Math.log2(3), 12);
    expect(atSecond).toBeLessThan(1);
  });

  test('nDCG@10 is 0 when there are no relevant refs', () => {
    expect(ndcgAtK(['a'], [], 10)).toBe(0);
  });

  test('aggregate MRR/nDCG skip negatives (no expected refs)', () => {
    const metrics = computeRankingMetrics([
      { topk: ['a'], expected: ['a'] },
      { topk: [], expected: [] },
    ]);
    expect(metrics.cases).toBe(2);
    expect(metrics.relevant_cases).toBe(1);
    expect(metrics.mrr).toBe(1);
    expect(metrics.ndcg_at_10).toBeCloseTo(1, 12);
  });
});
