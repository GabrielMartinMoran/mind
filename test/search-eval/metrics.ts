// ── Ranking metrics for the search evaluation suite ──
//
// Metrics are computed per case over the top-k retrieved refs, where
// `k = case.params.limit ?? DEFAULT_K`. See `computeVerdict` for the exact
// conventions on empty retrievals and empty label sets.

import { dedupeRefs } from './refs';
import type { CaseParams, EvalCase } from './types';

export const DEFAULT_K = 10;

/** Per-case evaluation result. */
export interface CaseVerdict {
  id: string;
  k: number;
  /** Full ordered retrieved refs (deduped). */
  refs: string[];
  /** First k retrieved refs. */
  topK: string[];
  expected: string[];
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  passed: boolean;
  /** A negative case that returned at least one result. */
  noise: boolean;
}

export function resolveK(params: CaseParams | undefined, defaultK: number = DEFAULT_K): number {
  const limit = params?.limit;
  if (limit === undefined || limit <= 0) return defaultK;
  return limit;
}

/**
 * Compute a single case verdict from the ordered list of retrieved refs.
 *
 * Conventions:
 * - precision = tp / (tp + fp); when nothing was retrieved, precision is 1 if
 *   the label set is empty, otherwise 0.
 * - recall = tp / (tp + fn); when the label set is empty, recall is 1
 *   (vacuously complete) — negativity is tracked separately via `noise`.
 * - passed = every expected label is inside top-k AND a negative case returned
 *   nothing.
 */
export function computeVerdict(
  observedRefs: string[],
  evalCase: EvalCase,
  defaultK: number = DEFAULT_K
): CaseVerdict {
  const k = resolveK(evalCase.params, defaultK);
  const refs = dedupeRefs(observedRefs);
  const topK = refs.slice(0, k);
  const expectedSet = new Set(evalCase.expected);

  let tp = 0;
  let fp = 0;
  for (const ref of topK) {
    if (expectedSet.has(ref)) tp += 1;
    else fp += 1;
  }

  let fn = 0;
  for (const ref of expectedSet) {
    if (!topK.includes(ref)) fn += 1;
  }

  const precision = tp + fp === 0 ? (expectedSet.size === 0 ? 1 : 0) : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const isNegative = expectedSet.size === 0;
  const noise = isNegative && refs.length > 0;
  const passed = fn === 0 && !noise;

  return {
    id: evalCase.id,
    k,
    refs,
    topK,
    expected: [...evalCase.expected],
    tp,
    fp,
    fn,
    precision,
    recall,
    passed,
    noise,
  };
}

/** Aggregated metrics for a segment (overall, by origin, by level, by type). */
export interface SegmentMetrics {
  cases: number;
  passed: number;
  avgPrecision: number;
  avgRecall: number;
  tp: number;
  fp: number;
  fn: number;
  negatives: number;
  noiseCases: number;
  noiseRate: number;
}

export function aggregateVerdicts(verdicts: CaseVerdict[]): SegmentMetrics {
  const cases = verdicts.length;
  if (cases === 0) {
    return {
      cases: 0,
      passed: 0,
      avgPrecision: 0,
      avgRecall: 0,
      tp: 0,
      fp: 0,
      fn: 0,
      negatives: 0,
      noiseCases: 0,
      noiseRate: 0,
    };
  }

  let passed = 0;
  let sumPrecision = 0;
  let sumRecall = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let negatives = 0;
  let noiseCases = 0;

  for (const verdict of verdicts) {
    if (verdict.passed) passed += 1;
    sumPrecision += verdict.precision;
    sumRecall += verdict.recall;
    tp += verdict.tp;
    fp += verdict.fp;
    fn += verdict.fn;
    if (verdict.expected.length === 0) {
      negatives += 1;
      if (verdict.noise) noiseCases += 1;
    }
  }

  return {
    cases,
    passed,
    avgPrecision: sumPrecision / cases,
    avgRecall: sumRecall / cases,
    tp,
    fp,
    fn,
    negatives,
    noiseCases,
    noiseRate: negatives === 0 ? 0 : noiseCases / negatives,
  };
}

/** Group verdicts by a key selector and aggregate each segment. */
export function aggregateBy<K extends string>(
  verdicts: CaseVerdict[],
  keyOf: (verdict: CaseVerdict) => K
): Record<K, SegmentMetrics> {
  const groups = new Map<K, CaseVerdict[]>();
  for (const verdict of verdicts) {
    const key = keyOf(verdict);
    const bucket = groups.get(key);
    if (bucket) bucket.push(verdict);
    else groups.set(key, [verdict]);
  }
  const out = {} as Record<K, SegmentMetrics>;
  for (const [key, bucket] of groups) {
    out[key] = aggregateVerdicts(bucket);
  }
  return out;
}
