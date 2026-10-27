// Experiment C — pure helpers for multi-evidence / top-K / neighbor analysis.
//
// Everything here is deterministic and free of I/O, clock and LLM calls:
//   * `interleaveLists` fixes the E-A S5/S6 truncation artifact by alternating
//     two ranked lists instead of letting the first query consume the budget.
//   * `contentHalves` / `entityContentQueries` build the <=2 complementary
//     S2-style queries used by the two-query-budget-10 option.
//   * `parseTurnName` / `neighborNames` / `expandNeighbors` derive session
//     neighbors from the stored names (`D<session>:<turn>`) — no graph, no
//     invented relations, no extra persistence.
//   * `evaluateRanking` / `summarize` score "any evidence" vs "all evidence"
//     and context-token cost.

import {
  contextTokensAtK,
  evidenceRecallAtK,
  mrr,
  precisionAtK,
} from '../../src/metrics/retrieval';
import { contentWords, entityTokens } from '../query-strategies/strategies';

export interface RankedMemory {
  readonly name: string;
  readonly content: string;
}

/** Round-robin interleave of ranked lists, deduped by name, capped at `limit`. */
export function interleaveLists(
  lists: readonly (readonly RankedMemory[])[],
  limit: number
): RankedMemory[] {
  const seen = new Set<string>();
  const out: RankedMemory[] = [];
  if (limit <= 0) return out;
  const depth = Math.max(0, ...lists.map(list => list.length));
  for (let index = 0; index < depth; index += 1) {
    for (const list of lists) {
      const item = list[index];
      if (!item || seen.has(item.name)) continue;
      seen.add(item.name);
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function dedupeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Two S2-style content queries: contiguous halves of the content words.
 * Falls back to the original question when there is nothing to split.
 */
export function contentHalves(question: string): string[] {
  const tokens = contentWords(question);
  if (tokens.length === 0) return [question];
  if (tokens.length === 1) return [tokens[0]!];
  const middle = Math.ceil(tokens.length / 2);
  return dedupeQueries([tokens.slice(0, middle).join(' '), tokens.slice(middle).join(' ')]);
}

/**
 * Two complementary focused queries: generic entity tokens and the S2 content
 * query. Empty sides are dropped; the original question is the fallback.
 */
export function entityContentQueries(question: string, participants: readonly string[]): string[] {
  const entity = entityTokens(question, { participants }).join(' ');
  const content = contentWords(question).join(' ');
  const queries = dedupeQueries([entity, content]);
  return queries.length > 0 ? queries : [question];
}

export interface TurnName {
  /** Session prefix, e.g. `D8` for `D8:12`. */
  readonly session: string;
  /** 1-based turn number inside the session. */
  readonly turn: number;
}

/** Parse a stored V1 memory name (`D<session>:<turn>`); null otherwise. */
export function parseTurnName(name: string): TurnName | null {
  const match = /^([A-Za-z]+\d*):(\d+)$/.exec(name);
  if (!match) return null;
  const session = match[1]!;
  const turn = Number(match[2]);
  if (!Number.isInteger(turn)) return null;
  return { session, turn };
}

/** Existing neighbors of a turn, closest first: +1, -1 (and +2, -2 for window 2). */
export function neighborNames(
  name: string,
  window: 1 | 2,
  available: ReadonlySet<string>
): string[] {
  const parsed = parseTurnName(name);
  if (!parsed) return [];
  const deltas = window === 1 ? [1, -1] : [1, -1, 2, -2];
  const names: string[] = [];
  for (const delta of deltas) {
    const candidate = `${parsed.session}:${parsed.turn + delta}`;
    if (available.has(candidate)) names.push(candidate);
  }
  return names;
}

/**
 * Expand retrieved seeds with same-session neighbors until `budget`.
 * Seeds stay in ranking order; each seed is immediately followed by its
 * neighbors before the next seed, so the budget is shared instead of being
 * consumed entirely by the seeds.
 */
export function expandNeighbors(
  seeds: readonly RankedMemory[],
  budget: number,
  window: 1 | 2,
  catalog: ReadonlyMap<string, string>
): RankedMemory[] {
  const out: RankedMemory[] = [];
  const seen = new Set<string>();
  const available = new Set(catalog.keys());
  const push = (name: string): boolean => {
    if (out.length >= budget || seen.has(name)) return out.length >= budget;
    const content = catalog.get(name);
    if (content === undefined) return false;
    seen.add(name);
    out.push({ name, content });
    return out.length >= budget;
  };

  for (const seed of seeds) {
    if (push(seed.name)) break;
    for (const neighbor of neighborNames(seed.name, window, available)) {
      if (push(neighbor)) break;
    }
    if (out.length >= budget) break;
  }
  return out;
}

export interface Evaluation {
  readonly goldCount: number;
  readonly matchedWithinK: number;
  readonly any: boolean;
  readonly full: boolean;
  readonly recall: number | null;
  readonly rr: number | null;
  readonly precision: number | null;
  readonly tokens: number;
  readonly resultCount: number;
  readonly latencyMs: number;
}

/** Evaluate one ranked list at `k`; MRR depth is `max(25, k)` as in E-A/E-B. */
export function evaluateRanking(
  ranked: readonly RankedMemory[],
  gold: readonly string[],
  k: number,
  latencyMs = 0
): Evaluation {
  const refs = ranked.map(memory => memory.name);
  const contents = ranked.map(memory => memory.content);
  if (gold.length === 0) {
    return {
      goldCount: 0,
      matchedWithinK: 0,
      any: false,
      full: false,
      recall: null,
      rr: null,
      precision: null,
      tokens: contextTokensAtK(contents, k),
      resultCount: ranked.length,
      latencyMs,
    };
  }
  const top = new Set(refs.slice(0, Math.max(0, k)));
  const matchedWithinK = gold.filter(item => top.has(item)).length;
  return {
    goldCount: gold.length,
    matchedWithinK,
    any: matchedWithinK > 0,
    full: matchedWithinK === gold.length,
    recall: evidenceRecallAtK(refs, gold, k),
    rr: mrr(refs, gold, Math.max(25, k)),
    precision: precisionAtK(refs, gold, k),
    tokens: contextTokensAtK(contents, k),
    resultCount: ranked.length,
    latencyMs,
  };
}

export interface Summary {
  readonly probes: number;
  readonly evidence_count: number;
  readonly any: number | null;
  readonly full: number | null;
  readonly recall: number | null;
  readonly mrr: number | null;
  readonly precision: number | null;
  readonly tokens: number | null;
  readonly mean_results: number;
  readonly zero_results: number;
  readonly latency_p50_ms: number | null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

export function summarize(evaluations: readonly Evaluation[]): Summary {
  const withGold = evaluations.filter(evaluation => evaluation.goldCount > 0);
  return {
    probes: evaluations.length,
    evidence_count: withGold.length,
    any: mean(withGold.map(evaluation => (evaluation.any ? 1 : 0))),
    full: mean(withGold.map(evaluation => (evaluation.full ? 1 : 0))),
    recall: mean(
      withGold
        .map(evaluation => evaluation.recall)
        .filter((value): value is number => value !== null)
    ),
    mrr: mean(
      withGold.map(evaluation => evaluation.rr).filter((value): value is number => value !== null)
    ),
    precision: mean(
      withGold
        .map(evaluation => evaluation.precision)
        .filter((value): value is number => value !== null)
    ),
    tokens: mean(evaluations.map(evaluation => evaluation.tokens)),
    mean_results: mean(evaluations.map(evaluation => evaluation.resultCount)) ?? 0,
    zero_results: evaluations.filter(evaluation => evaluation.resultCount === 0).length,
    latency_p50_ms: percentile(
      evaluations.map(evaluation => evaluation.latencyMs),
      50
    ),
  };
}

/** Full-evidence points gained per 1k extra context tokens (null when divide-by-zero). */
export function tokensPerFullPoint(
  baseTokens: number | null,
  baseFull: number | null,
  targetTokens: number | null,
  targetFull: number | null
): number | null {
  if (baseTokens === null || baseFull === null || targetTokens === null || targetFull === null) {
    return null;
  }
  const gain = (targetFull - baseFull) * 100;
  if (gain <= 0) return null;
  return (targetTokens - baseTokens) / gain;
}

/** Number of gold items matched within the first `k` positions. */
export function matchedWithin(ranked: readonly RankedMemory[], gold: readonly string[], k: number) {
  const top = new Set(ranked.slice(0, k).map(memory => memory.name));
  return gold.filter(item => top.has(item)).length;
}
