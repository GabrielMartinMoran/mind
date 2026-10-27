// Pure retrieval metrics for benchmark A1 (no LLM, no I/O, no clock).
//
// The ranked result list is authoritative: array order equals ranking order.
// Evidence is the LoCoMo `evidence` list, whose entries are stable memory names
// (`dia_id`). A small number of dataset questions carry no evidence; for those
// the evidence-based metrics are not defined and the functions return `null`
// (the A1 runner records them as N/A rather than zero).

/**
 * Approximate token count of a string used by the context-size metrics.
 *
 * LoCoMo turns are short natural-language utterances and the benchmark must
 * stay free/offline, so we deliberately do not ship a tokenizer. We use the
 * documented heuristic `ceil(chars / 4)` (roughly one token per four
 * characters, a common English approximation). This is an estimate only and is
 * reported as such.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * `hit@k` — true when **every** evidence reference appears within the first `k`
 * ranked results (all-evidence-present). Returns `false` for empty evidence
 * (nothing to hit); callers should record that case as N/A.
 */
export function hitAtK(
  rankedRefs: readonly string[],
  evidence: readonly string[],
  k: number
): boolean {
  if (evidence.length === 0) return false;
  const top = new Set(rankedRefs.slice(0, Math.max(0, k)));
  return evidence.every(ref => top.has(ref));
}

/**
 * `evidenceRecall@k` — fraction of the evidence references found in the first
 * `k` ranked results. Returns `null` when there is no evidence (N/A).
 */
export function evidenceRecallAtK(
  rankedRefs: readonly string[],
  evidence: readonly string[],
  k: number
): number | null {
  if (evidence.length === 0) return null;
  const top = new Set(rankedRefs.slice(0, Math.max(0, k)));
  const found = evidence.filter(ref => top.has(ref)).length;
  return found / evidence.length;
}

/**
 * `MRR` — reciprocal rank (1-based) of the first evidence reference found
 * within the first `maxRank` results, or `0` when none is found. Returns
 * `null` when there is no evidence (N/A). `maxRank` defaults to 25, the A1
 * top-25 window.
 */
export function mrr(
  rankedRefs: readonly string[],
  evidence: readonly string[],
  maxRank = 25
): number | null {
  if (evidence.length === 0) return null;
  const limit = Math.min(Math.max(0, maxRank), rankedRefs.length);
  const evidenceSet = new Set(evidence);
  for (let i = 0; i < limit; i++) {
    const ref = rankedRefs[i];
    if (ref !== undefined && evidenceSet.has(ref)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * `precision@k` — fraction of the returned results in the first `k` that are
 * evidence. The denominator is the number of returned items up to `k` (i.e.
 * `min(k, results.length)`) so a short result set is not penalised for the
 * missing positions; `0` is returned when no results are returned. Returns
 * `null` when there is no evidence (N/A).
 */
export function precisionAtK(
  rankedRefs: readonly string[],
  evidence: readonly string[],
  k: number
): number | null {
  if (evidence.length === 0) return null;
  const considered = rankedRefs.slice(0, Math.max(0, k));
  if (considered.length === 0) return 0;
  const evidenceSet = new Set(evidence);
  const hits = considered.filter(ref => evidenceSet.has(ref)).length;
  return hits / considered.length;
}

/**
 * Total estimated context tokens of the first `k` result contents.
 */
export function contextTokensAtK(contents: readonly string[], k: number): number {
  let total = 0;
  for (const content of contents.slice(0, Math.max(0, k))) {
    total += estimateTokens(content);
  }
  return total;
}
