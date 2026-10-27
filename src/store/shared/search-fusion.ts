// ── Search fusion (D4) + confidence (D5) ──
//
// Independent retrieval channels each produce a raw score per candidate
// (higher = better). Fusion normalizes every channel *per query* and combines
// them into one fused score, then derives a confidence bucket and provenance.
//
// Design invariants:
// - Deterministic: candidate order is fused score desc → name asc → id asc
//   (string compares; no numeric id subtraction, which was NaN on UUIDs).
// - Normalization guards: an empty channel is absent; an all-equal channel
//   contributes 1.0 to each of its candidates.
// - Agreement is rewarded: every extra channel beyond the first adds a small
//   bonus, capped so it can never dominate the weighted score.

import { normalizeToken, tokenize } from './matching-tokenizer';
import type { ParsedQuery, QueryNode } from './query-parser';

/**
 * Minimum shared prefix for conservative morphology tolerance in the admission
 * predicate. Two tokens (each at least this long) are treated as a match when
 * they share a prefix this long, bridging inflections like `ogros`/`ogro`
 * without collapsing unrelated words.
 */
export const MORPH_MIN_PREFIX_LENGTH = 4;

/** A retrieval channel id, used in `methods` provenance. */
export type SearchChannelMethod =
  | 'phrase'
  | 'all'
  | 'any'
  | 'like'
  | 'trigram'
  | 'fuzzy'
  | 'token_set'
  | 'semantic';

/** Per-result confidence bucket. */
export type SearchConfidence = 'high' | 'medium' | 'low';

/**
 * Compatibility channel summary for a single result (`search_method` in
 * surface payloads). Groups lexical rungs as `fts5`; a result matched by more
 * than one group is `mixed`.
 */
export type CompatSearchMethod = 'fts5' | 'like' | 'trigram' | 'fuzzy' | 'embeddings' | 'mixed';

/**
 * Channel weights for the weighted convex combination.
 *
 * Tuned against the fixture evaluation suite (see T4 report): stronger lexical
 * channels dominate; semantic sits high when embeddings are enabled; fuzzy and
 * token-set are deliberately weak so they add recall without outranking exact
 * matches.
 */
export const SEARCH_CHANNEL_WEIGHTS: Record<SearchChannelMethod, number> = {
  phrase: 1.0,
  all: 0.9,
  any: 0.55,
  semantic: 0.8,
  trigram: 0.6,
  fuzzy: 0.4,
  like: 0.5,
  token_set: 0.3,
};

/** Bonus added per additional matching channel (agreement reward). */
export const AGREEMENT_BONUS_PER_CHANNEL = 0.05;
/** Hard cap on the total agreement bonus so it stays a tie-breaker. */
export const AGREEMENT_BONUS_CAP = 0.15;

/** Relative fused score at/above which a strong lexical match is `high`. */
export const HIGH_CONFIDENCE_SCORE_FLOOR = 0.6;
/** Raw semantic similarity at/above which a semantic-only match is `medium`. */
export const SEMANTIC_MEDIUM_FLOOR = 0.6;

/** Fixed channel precedence for stable, deterministic `methods` ordering. */
const CHANNEL_ORDER: SearchChannelMethod[] = [
  'phrase',
  'all',
  'any',
  'semantic',
  'trigram',
  'fuzzy',
  'like',
  'token_set',
];

/** Raw per-candidate scores for one channel; absent ids are not in the channel. */
export interface ChannelScores {
  method: SearchChannelMethod;
  /** raw score per candidate id; higher is better. */
  scores: Map<string, number>;
}

export interface FusedCandidate<T> {
  item: T;
  /** Weighted sum of normalized channel scores + agreement bonus. */
  fusedScore: number;
  /** Fused score normalized to 0..1 relative to the best result in the set. */
  score: number;
  /** Channels that produced this candidate, in fixed precedence order. */
  methods: SearchChannelMethod[];
  /** Raw cosine similarity when the semantic channel matched this candidate. */
  semanticScore?: number;
  confidence: SearchConfidence;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Min-max normalize a channel's raw scores.
 *
 * Guards: an empty channel yields an empty map (the channel is absent); a
 * channel whose scores are all equal yields 1.0 for every candidate (the
 * channel contributes its full weight rather than a division by zero).
 */
export function normalizeChannelScores(scores: Map<string, number>): Map<string, number> {
  const normalized = new Map<string, number>();
  if (scores.size === 0) return normalized;

  let min = Infinity;
  let max = -Infinity;
  for (const value of scores.values()) {
    const v = finite(value);
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min === max) {
    for (const id of scores.keys()) normalized.set(id, 1);
    return normalized;
  }

  for (const [id, value] of scores) {
    normalized.set(id, (finite(value) - min) / (max - min));
  }
  return normalized;
}

/**
 * Fraction of distinct query tokens present in a document (token-set coverage).
 * `0` for an empty query; `1` when every query token is present.
 */
export function tokenSetScore(queryTokens: string[], documentTokens: Iterable<string>): number {
  const unique = [...new Set(queryTokens)];
  if (unique.length === 0) return 0;
  const present = new Set(documentTokens);
  let matched = 0;
  for (const token of unique) if (present.has(token)) matched += 1;
  return matched / unique.length;
}

/** Folded words of a document, used for morphology and prefix matching. */
function documentWords(foldedText: string): Set<string> {
  return new Set(tokenize(foldedText));
}

/**
 * Whether a folded document token-set covers a query token: exact folded
 * substring, or a conservative morphology match (shared prefix ≥
 * {@link MORPH_MIN_PREFIX_LENGTH}). Mirrors the relevance definition used by
 * the evaluation ground truth so admission does not invent its own semantics.
 */
function documentCoversToken(token: string, foldedText: string, words: Set<string>): boolean {
  if (foldedText.includes(token)) return true;
  if (token.length < MORPH_MIN_PREFIX_LENGTH) return false;
  // Inflection tolerance: accept a document word only when one is a prefix of
  // the other (e.g. `ogros`/`ogro`), never when they merely share a prefix
  // (`formanc`/`formato` must not match).
  for (const word of words) {
    if (word.length < MORPH_MIN_PREFIX_LENGTH) continue;
    if (word.startsWith(token) || token.startsWith(word)) return true;
  }
  return false;
}

/** Number of distinct query tokens a document covers (folded, morphology-aware). */
export function countCoveredQueryTokens(
  queryTokens: string[],
  name: string,
  content: string
): number {
  const foldedText = normalizeToken(`${name} ${content}`);
  const words = documentWords(foldedText);
  let covered = 0;
  for (const token of new Set(queryTokens)) {
    if (documentCoversToken(token, foldedText, words)) covered += 1;
  }
  return covered;
}

/** Whether a document satisfies a single query node. */
function documentSatisfiesNode(node: QueryNode, foldedText: string, words: Set<string>): boolean {
  if (node.type === 'phrase') return foldedText.includes(normalizeToken(node.text));
  if (node.prefix) {
    for (const word of words) if (word.startsWith(node.token)) return true;
    return false;
  }
  return tokenize(node.token).every(token => documentCoversToken(token, foldedText, words));
}

/**
 * Admission predicate: a candidate document is relevant when it satisfies at
 * least one OR-group of the parsed query under folded, morphology-tolerant
 * token matching (every node of the group matches). This is the semantic
 * contract the relaxation channels are allowed to surface — weaker partial
 * matches stay out of the result set regardless of which channel found them.
 *
 * A query with no positive groups admits nothing.
 */
export function documentSatisfiesQuery(ast: ParsedQuery, name: string, content: string): boolean {
  if (ast.groups.length === 0) return false;
  const foldedText = normalizeToken(`${name} ${content}`);
  const words = documentWords(foldedText);
  return ast.groups.some(group =>
    group.nodes.every(node => documentSatisfiesNode(node, foldedText, words))
  );
}

/** Confidence bucket from channel classes, relative score and semantic score. */
export function computeConfidence(
  methods: SearchChannelMethod[],
  relativeScore: number,
  semanticScore?: number
): SearchConfidence {
  const hasStrong = methods.includes('phrase') || methods.includes('all');
  const hasMediumLexical =
    methods.includes('any') ||
    methods.includes('trigram') ||
    methods.includes('like') ||
    methods.includes('token_set');

  if (hasStrong) return relativeScore >= HIGH_CONFIDENCE_SCORE_FLOOR ? 'high' : 'medium';
  if (hasMediumLexical) return 'medium';
  if (methods.includes('semantic')) {
    return (semanticScore ?? 0) >= SEMANTIC_MEDIUM_FLOOR ? 'medium' : 'low';
  }
  // Fuzzy-only, like-only fallthrough, or no lexical channel: weak.
  return 'low';
}

/** Map a result's methods to the compatibility `search_method` vocabulary. */
export function toCompatSearchMethod(methods: SearchChannelMethod[]): CompatSearchMethod {
  const groups = new Set<CompatSearchMethod>();
  if (methods.some(m => m === 'phrase' || m === 'all' || m === 'any' || m === 'token_set')) {
    groups.add('fts5');
  }
  if (methods.includes('semantic')) groups.add('embeddings');
  if (methods.includes('trigram')) groups.add('trigram');
  if (methods.includes('fuzzy')) groups.add('fuzzy');
  if (methods.includes('like')) groups.add('like');

  if (groups.size === 0) return 'fts5';
  if (groups.size === 1) return [...groups][0]!;
  return 'mixed';
}

function sortMethods(methods: Iterable<SearchChannelMethod>): SearchChannelMethod[] {
  return [...new Set(methods)].sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
}

interface Accumulator {
  fused: number;
  methods: Set<SearchChannelMethod>;
  semanticScore?: number;
}

/**
 * Fuse per-channel candidate scores into a single deterministic ranking.
 *
 * Candidates not produced by any channel are dropped. `item` must carry `id`
 * and `name` for deterministic tie-breaking.
 */
export function fuseCandidates<T extends { id: string; name: string }>(
  candidates: T[],
  channels: ChannelScores[]
): FusedCandidate<T>[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const accumulators = new Map<string, Accumulator>();

  for (const channel of channels) {
    const normalized = normalizeChannelScores(channel.scores);
    const weight = SEARCH_CHANNEL_WEIGHTS[channel.method];

    for (const [id, normalizedScore] of normalized) {
      if (!byId.has(id)) continue;
      let entry = accumulators.get(id);
      if (!entry) {
        entry = { fused: 0, methods: new Set() };
        accumulators.set(id, entry);
      }
      entry.fused += weight * normalizedScore;
      entry.methods.add(channel.method);
      if (channel.method === 'semantic') {
        entry.semanticScore = finite(channel.scores.get(id) ?? 0);
      }
    }
  }

  let maxFused = 0;
  for (const entry of accumulators.values()) {
    const extraChannels = Math.max(0, entry.methods.size - 1);
    const bonus = Math.min(AGREEMENT_BONUS_CAP, extraChannels * AGREEMENT_BONUS_PER_CHANNEL);
    entry.fused += bonus;
    if (entry.fused > maxFused) maxFused = entry.fused;
  }

  const results: FusedCandidate<T>[] = [];
  for (const [id, entry] of accumulators) {
    const item = byId.get(id)!;
    const methods = sortMethods(entry.methods);
    const score = maxFused > 0 ? entry.fused / maxFused : 0;
    results.push({
      item,
      fusedScore: entry.fused,
      score,
      methods,
      ...(entry.semanticScore !== undefined ? { semanticScore: entry.semanticScore } : {}),
      confidence: computeConfidence(methods, score, entry.semanticScore),
    });
  }

  results.sort(
    (a, b) =>
      b.fusedScore - a.fusedScore ||
      compareStrings(a.item.name, b.item.name) ||
      compareStrings(a.item.id, b.item.id)
  );
  return results;
}
