// ── Ranking metrics (MRR, nDCG@10) for the v2 evaluation suite ──
//
// Computed post-hoc from each case's ordered `topk` and its expected refs. These
// are additive: the v1 metric shape (`metrics.ts`) is untouched, and no v1
// snapshot field changes.
//
// Conventions:
// - Relevance is binary: a ref is relevant iff it is in the case's `expected`.
// - Cases with no expected refs (negatives / irrelevant-query cases) carry no
//   ranking signal and are EXCLUDED from the aggregate MRR/nDCG (they are still
//   measured by precision/recall/noise in the shared metrics).
// - Empty retrievals and misses contribute 0 to both per-case metrics.

export const NDCG_K = 10;

/** 1/rank of the first relevant ref in `topk`, or 0 if none is present. */
export function reciprocalRank(topk: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const relevant = new Set(expected);
  for (let index = 0; index < topk.length; index++) {
    if (relevant.has(topk[index]!)) return 1 / (index + 1);
  }
  return 0;
}

/** Discounted cumulative gain at k with binary relevance (log2 base). */
export function dcgAtK(topk: string[], expected: string[], k: number = NDCG_K): number {
  const relevant = new Set(expected);
  const limit = Math.min(k, topk.length);
  let dcg = 0;
  for (let index = 0; index < limit; index++) {
    if (relevant.has(topk[index]!)) dcg += 1 / Math.log2(index + 2);
  }
  return dcg;
}

/** Ideal DCG at k: all `relevantCount` relevant refs ranked first. */
export function idcgAtK(relevantCount: number, k: number = NDCG_K): number {
  const limit = Math.min(k, relevantCount);
  let idcg = 0;
  for (let index = 0; index < limit; index++) {
    idcg += 1 / Math.log2(index + 2);
  }
  return idcg;
}

/** nDCG@k with binary relevance. 0 when there are no relevant refs. */
export function ndcgAtK(topk: string[], expected: string[], k: number = NDCG_K): number {
  const ideal = idcgAtK(new Set(expected).size, k);
  if (ideal === 0) return 0;
  return dcgAtK(topk, expected, k) / ideal;
}

/** A single row of ranking inputs. */
export interface RankingRow {
  topk: string[];
  expected: string[];
}

export interface RankingMetrics {
  /** Mean reciprocal rank over cases that have at least one expected ref. */
  mrr: number;
  /** Mean nDCG@10 over cases that have at least one expected ref. */
  ndcg_at_10: number;
  /** Number of cases that contributed (expected refs present). */
  relevant_cases: number;
  /** Total rows considered (including negatives, which do not contribute). */
  cases: number;
}

/** Aggregate MRR and mean nDCG@10, skipping cases with no expected refs. */
export function computeRankingMetrics(rows: RankingRow[], k: number = NDCG_K): RankingMetrics {
  let sumRR = 0;
  let sumNdcg = 0;
  let relevantCases = 0;
  for (const row of rows) {
    if (row.expected.length === 0) continue;
    relevantCases += 1;
    sumRR += reciprocalRank(row.topk, row.expected);
    sumNdcg += ndcgAtK(row.topk, row.expected, k);
  }
  return {
    mrr: relevantCases === 0 ? 0 : sumRR / relevantCases,
    ndcg_at_10: relevantCases === 0 ? 0 : sumNdcg / relevantCases,
    relevant_cases: relevantCases,
    cases: rows.length,
  };
}
