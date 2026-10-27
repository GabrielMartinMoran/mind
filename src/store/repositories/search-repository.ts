// ── SearchRepository: handles all search operations ──

import type { Database } from 'bun:sqlite';

import {
  blobToVector,
  isRagEnabled,
  isSemanticBreakerOpen,
  recordSemanticFailure,
  semanticSearch,
} from '../../helpers/rag';
import { normalizeTag } from '../../helpers/tags';
import type {
  BoundedMemorySummaryResult,
  MemoryQueryFilter,
  MemorySummary,
  SearchResult,
  Tier,
} from '../../types';
import {
  buildPrimaryMatch,
  buildRungs,
  canBypassLexicalAdmission,
  countCoveredQueryTokens,
  documentSatisfiesQuery,
  EmptySearchQueryError,
  foldedWords,
  fuseCandidates,
  hasInformativeQueryTerms,
  isEmptyQuery,
  normalizeDateBound,
  buildInformativeAnyMatch,
  informativeSearchTokens,
  isNaturalLanguageRecall,
  normalizeToken,
  parseQuery,
  selectSemanticAdmittedIds,
  storeGeneration,
  tokenSetScore,
  tokenize,
  type ChannelScores,
  type FusedCandidate,
  type ParsedQuery,
  type SearchChannelMethod,
  type SearchConfidence,
} from '../shared';
import { dataVersion } from '../shared/matching-tokenizer';

import type { MemoryRepository } from './memory-repository';
import type { TagRepository } from './tag-repository';

// ── Trigram substring + fuzzy (Damerau–Levenshtein) channel constants (D3) ──

/** Minimum term length for the trigram substring channel (FTS5 trigram needs ≥3). */
export const TRIGRAM_MIN_LENGTH = 3;
/** Maximum Damerau–Levenshtein edit distance for fuzzy matching. */
export const FUZZY_MAX_DISTANCE = 2;
/**
 * Minimum shared prefix length required before scoring edit distance.
 *
 * Deliberately equal to {@link TRIGRAM_MIN_LENGTH}. This is the documented P-A
 * limitation (fallback from the v10 P-D dictionary, plan §8bis): a typo in the
 * first three characters of a word is not recoverable, because only vocabulary
 * terms that share a 3-character prefix with the query token are considered.
 * Restoring the prefix remains load-bearing: the fuzzy candidate vocabulary is
 * the full folded document vocabulary (no `LIMIT` truncation), but the prefix
 * rule keeps first-3-character expansions out, matching the frozen baseline.
 */
export const FUZZY_PREFIX_LENGTH = TRIGRAM_MIN_LENGTH;
/** Maximum number of fuzzy term expansions queried per search. */
export const FUZZY_MAX_EXPANSIONS = 50;
/** Minimum cosine similarity for a semantic candidate to enter fusion (D3h). */
const SEMANTIC_CANDIDATE_FLOOR = 0.3;
/** Maximum number of semantic candidates considered per query (D3h top-50). */
const SEMANTIC_TOP_K = 50;

// ── Optional search diagnostics sink (default NULL; env-gated) ──
//
// Emits COUNTS and TIMINGS only — never memory content, names, or query text.
// With no installed sink, the hot path pays a null-slot check plus one
// `process.env.MIND_SEARCH_DIAG` read per search call (env lookup only; no sink,
// allocation, or formatting). Enabling it never changes results, ordering, or
// the public contract.

/** Per-channel telemetry gathered by the optional diagnostics sink. */
export interface SearchChannelDiagnostic {
  channel: SearchChannelMethod;
  /** Wall-clock milliseconds spent in the channel. */
  ms: number;
  /** Candidates the channel contributed (its distinct matched ids). */
  candidates: number;
}

/** Content-free diagnostics aggregated for one `searchMemories` call. */
export interface SearchDiagnostics {
  channels: SearchChannelDiagnostic[];
  /** Total fuzzy expansion terms queried this call. */
  fuzzy_expansions: number;
  /** True when this call rebuilt the cached folded vocabulary (generation or `data_version` changed). */
  fuzzy_cache_rebuilt: boolean;
  /** Cross-connection `PRAGMA data_version` observed on this call's cache check. */
  data_version: number;
  /** Admission gate outcome: candidates kept vs. dropped (0 when RAG is off). */
  admission: { kept: number; dropped: number; semantic_admitted: number };
  /** Candidates collected across all channels before admission. */
  total_candidates: number;
  /** Wall-clock milliseconds for the whole `searchMemories` call. */
  total_ms: number;
}

export type SearchDiagnosticsSink = (diagnostics: SearchDiagnostics) => void;

let searchDiagnosticsSink: SearchDiagnosticsSink | null = null;

/**
 * Install (or clear, with `null`) the process-wide diagnostics sink. The sink is
 * a single module-level slot, so enabling it can never alter search results.
 */
export function setSearchDiagnosticsSink(sink: SearchDiagnosticsSink | null): void {
  searchDiagnosticsSink = sink;
}

/** Default sink used when `MIND_SEARCH_DIAG=1` and no explicit sink is set. */
function envDiagnosticsSink(diagnostics: SearchDiagnostics): void {
  process.stderr.write(`${JSON.stringify(diagnostics)}\n`);
}

/** Active sink, or null when diagnostics are disabled. */
function activeDiagnosticsSink(): SearchDiagnosticsSink | null {
  if (searchDiagnosticsSink !== null) return searchDiagnosticsSink;
  if (process.env.MIND_SEARCH_DIAG === '1') return envDiagnosticsSink;
  return null;
}

/**
 * Optimal string alignment (Damerau–Levenshtein) distance: insertions,
 * deletions, substitutions and adjacent transpositions each cost 1.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const distances: number[][] = Array.from({ length: aLen + 1 }, () =>
    new Array<number>(bLen + 1).fill(0)
  );
  for (let i = 0; i <= aLen; i += 1) distances[i]![0] = i;
  for (let j = 0; j <= bLen; j += 1) distances[0]![j] = j;

  for (let i = 1; i <= aLen; i += 1) {
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i]![j] = Math.min(
        distances[i - 1]![j]! + 1,
        distances[i]![j - 1]! + 1,
        distances[i - 1]![j - 1]! + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distances[i]![j] = Math.min(distances[i]![j]!, distances[i - 2]![j - 2]! + cost);
      }
    }
  }
  return distances[aLen]![bLen]!;
}

/**
 * Optimal string alignment (Damerau–Levenshtein) with a hard distance cap and
 * early exit. Returns a value strictly greater than `maxDistance` as soon as the
 * bound can be proven exceeded, so a caller comparing `<= maxDistance` gets the
 * same boolean result while doing far less work on dissimilar strings.
 */
export function bandedOsa(a: string, b: string, maxDistance: number): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  if (Math.abs(aLen - bLen) > maxDistance) return maxDistance + 1;

  // Two rolling rows plus the row two steps back for the transposition term.
  let prev2: number[] = new Array<number>(bLen + 1).fill(0);
  let prev: number[] = new Array<number>(bLen + 1);
  let current: number[] = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j += 1) prev[j] = j;

  const boundary = maxDistance + 1;
  for (let i = 1; i <= aLen; i += 1) {
    current[0] = i;
    let rowMin = current[0]!;
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j]! + 1, current[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2]! + cost);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return boundary;
    const swap = prev2;
    prev2 = prev;
    prev = current;
    current = swap;
  }
  return prev[bLen]!;
}

/** Length of the longest common leading substring of two strings. */
function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Unique, default-sorted folded vocabulary of a set of documents.
 *
 * This is the exact shape the production fuzzy channel caches
 * ({@link globalVocabulary}) and passes to {@link expandFuzzyTokens}: the
 * candidate scan relies on the unique-and-sorted precondition, because the
 * iteration order decides which expansions survive the cap.
 */
export function foldedVocabulary(rows: Iterable<{ name: string; content: string }>): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    for (const word of foldedWords(`${row.name} ${row.content}`)) set.add(word);
  }
  return [...set].sort();
}

/**
 * Expand each query token into close vocabulary terms within
 * {@link FUZZY_MAX_DISTANCE} edits that share a {@link FUZZY_PREFIX_LENGTH}
 * prefix, using a length band and a banded/early-exit OSA comparison.
 *
 * Deterministic: tokens are sorted, matches inherit the (already sorted)
 * vocabulary order, and at most `maxExpansions` terms are collected in total.
 *
 * **Precondition:** `vocabulary` must already be unique and default-sorted (as
 * produced by {@link foldedVocabulary}). The production caller passes the
 * shared, cached vocabulary array directly, so this function never copies,
 * re-sorts or mutates it. The iteration order determines which expansions
 * survive the cap, so callers must not pass an unsorted or duplicated array.
 */
export function expandFuzzyTokens(
  tokens: string[],
  vocabulary: readonly string[],
  maxExpansions: number = FUZZY_MAX_EXPANSIONS
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let budget = maxExpansions;

  for (const token of [...new Set(tokens)].sort()) {
    const matches: string[] = [];
    if (token.length >= FUZZY_PREFIX_LENGTH) {
      for (const word of vocabulary) {
        if (budget <= 0) break;
        if (word === token) continue;
        if (sharedPrefixLength(word, token) < FUZZY_PREFIX_LENGTH) continue;
        if (Math.abs(word.length - token.length) > FUZZY_MAX_DISTANCE) continue;
        if (bandedOsa(word, token, FUZZY_MAX_DISTANCE) <= FUZZY_MAX_DISTANCE) {
          matches.push(word);
          budget -= 1;
        }
      }
    }
    result.set(token, matches);
  }
  return result;
}

/** Normalized (folded) leaf tokens of a query's positive nodes. */
function eligibleTokens(ast: ParsedQuery): string[] {
  const tokens = new Set<string>();
  for (const group of ast.groups) {
    for (const node of group.nodes) {
      if (node.type === 'term') for (const token of tokenize(node.token)) tokens.add(token);
      else for (const token of tokenize(node.text)) tokens.add(token);
    }
  }
  return [...tokens];
}

/**
 * Coverage floor for the coverage-guarded channels: a single-token query needs
 * its one token; otherwise a candidate must contain at least half of the query's
 * positive tokens, with an absolute minimum of two.
 */
function coverageFloor(tokenCount: number): number {
  return tokenCount <= 1 ? 1 : Math.max(2, Math.floor(tokenCount / 2));
}

export interface SearchRepository {
  searchMemories(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[]; semantic?: boolean }
  ): Promise<ScoredSearchResult[]>;
  searchFallback(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<{ results: SearchResult[]; search_method: string }>;
  searchFts5(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<SearchResult[]>;
  searchLike(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): SearchResult[];
  searchSemantic(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<SearchResult[]>;
  queryMemories(filter?: MemoryQueryFilter): MemorySummary[];
  queryMemoriesCount(filter: {
    space?: string;
    tag?: string;
    tier?: number;
    tiers?: Tier[];
    from?: string;
    to?: string;
  }): Promise<number>;
  getTrendingMemories(space: string, tier: Tier, limit: number): BoundedMemorySummaryResult;
  getLivingReferences(space: string, limit: number): BoundedMemorySummaryResult;
  getSpaceGraph(
    space: string,
    opts?: { limit?: number; maxLimit?: number }
  ): {
    nodes: { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }[];
    meta: {
      total_nodes: number;
      returned_nodes: number;
      requested_limit: number;
      applied_limit: number;
      max_limit: number;
      truncated: boolean;
    };
  };
}

/** Minimal shape needed to fuse candidates from multiple channels. */
export interface RankedRow {
  id: string;
  rank: number;
  name: string;
}

/**
 * Engine-level search result: the base {@link SearchResult} enriched with the
 * fused score, confidence bucket and channel provenance (D4/D5). Surfaces
 * consume these fields in T5.
 */
export interface ScoredSearchResult extends SearchResult {
  score: number;
  confidence: SearchConfidence;
  methods: SearchChannelMethod[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface SearchRow extends RankedRow {
  space_name: string;
  content: string;
  tier: Tier;
  pinned: number;
  created_at: string;
  updated_at: string;
  changed_at: string;
}

/** A tier restriction: a non-empty `tiers` list wins over the single `tier`. */
type TierCriteria = { tier?: Tier; tiers?: Tier[] };

/**
 * Build a SQL fragment restricting a column to the selected tiers. Single-tier
 * and multi-tier filters share one `IN (?, ...)` form so behavior is identical.
 */
function tierClause(
  filter: TierCriteria | undefined,
  column = 'm.tier'
): { sql: string; params: Tier[] } {
  const tiers =
    filter?.tiers && filter.tiers.length > 0
      ? filter.tiers
      : filter?.tier !== undefined
        ? [filter.tier]
        : [];
  if (tiers.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${tiers.map(() => '?').join(',')})`, params: tiers };
}

function getTagsForMemory(db: Database, memoryId: string): string[] {
  const rows = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(memoryId) as {
    tag: string;
  }[];
  return rows.map(r => r.tag);
}

function matchedTokenCount(tokens: string[], name: string, content: string): number {
  const present = new Set(tokenize(`${name} ${content}`));
  return tokens.reduce((count, token) => (present.has(token) ? count + 1 : count), 0);
}

export function createSearchRepository(
  db: Database,
  _memoryRepo: MemoryRepository,
  _tagRepo: TagRepository
): SearchRepository {
  function toSearchResult(row: SearchRow, similarity?: number): SearchResult {
    return {
      id: row.id,
      space_name: row.space_name,
      name: row.name,
      content: row.content,
      tier: row.tier,
      pinned: row.pinned === 1,
      tags: getTagsForMemory(db, row.id),
      rank: row.rank,
      similarity,
      created_at: row.created_at,
      updated_at: row.updated_at,
      changed_at: row.changed_at,
    };
  }

  /** Run one FTS5 MATCH expression and return its rows (rank-ordered). */
  function runMatchQuery(
    match: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): SearchRow[] {
    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at, fts.rank
            FROM memories_fts fts
            JOIN memories m ON m.fts_id = fts.rowid
            JOIN spaces s ON s.id = m.space_id
            WHERE memories_fts MATCH ?
        `;
    const params: any[] = [match];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    sql += tierFilter.sql;
    params.push(...tierFilter.params);

    sql += ' ORDER BY fts.rank';

    let rows = db.query(sql).all(...params) as SearchRow[];

    // Post-filter by tag (requires join)
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }

    return rows;
  }

  /** Run one trigram-compiled MATCH expression and return its rows (rank-ordered). */
  function runTrigramMatch(
    match: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): SearchRow[] {
    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at, tri.rank
            FROM memories_fts_trigram tri
            JOIN memories m ON m.fts_id = tri.rowid
            JOIN spaces s ON s.id = m.space_id
            WHERE memories_fts_trigram MATCH ?
        `;
    const params: any[] = [match];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    sql += tierFilter.sql;
    params.push(...tierFilter.params);

    sql += ' ORDER BY tri.rank';

    let rows = db.query(sql).all(...params) as SearchRow[];

    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }

    return rows;
  }

  /** Number of query tokens present as substrings of a candidate's folded text. */
  function substringCoverage(tokens: string[], name: string, content: string): number {
    const text = normalizeToken(`${name} ${content}`);
    return tokens.reduce((count, token) => (text.includes(token) ? count + 1 : count), 0);
  }

  /** Number of query tokens covered exactly or via a fuzzy expansion. */
  function fuzzyCoverage(
    tokens: string[],
    expansions: Map<string, string[]>,
    name: string,
    content: string
  ): number {
    const words = foldedWords(`${name} ${content}`);
    return tokens.reduce((count, token) => {
      if (words.has(token)) return count + 1;
      const expanded = expansions.get(token) ?? [];
      return expanded.some(word => words.has(word)) ? count + 1 : count;
    }, 0);
  }

  // ── P-A: per-store folded-document-vocabulary cache ──
  //
  // The fuzzy candidate vocabulary is the folded vocabulary of every document,
  // folded once and cached per store instance. It is a full scan (no
  // query-dependent, unordered `LIMIT` truncation — the old prefilter is gone),
  // so the retrieved vocabulary is deterministic; the prefix-3 rule is applied
  // at expansion time. The cache validity key is `{ generation, dataVersion }`:
  // local writes bump the generation (`FtsHelper`), while `PRAGMA data_version`
  // read on this same connection catches writes committed by OTHER
  // connections/processes. Either differing reloads, so a steady-state search
  // pays no SQL round-trip for candidate generation and writes — local or
  // external — can never leave a stale vocabulary behind.
  let vocabularyCache: { generation: number; dataVersion: number; terms: string[] } | null = null;

  function globalVocabulary(): { terms: string[]; rebuilt: boolean; dataVersion: number } {
    const generation = storeGeneration(db);
    // Read the cross-connection change counter on THIS connection immediately
    // before consulting the cache. It is unchanged by this connection's own
    // writes (covered by the generation) but advances when any other
    // connection/process commits. Race note: a write that commits between this
    // read and the vocabulary SELECT may or may not be included in the rebuild
    // started now; the next search will observe the advanced `data_version` and
    // rebuild again, so the cache can never stay permanently stale.
    const currentDataVersion = dataVersion(db);
    if (
      vocabularyCache !== null &&
      vocabularyCache.generation === generation &&
      vocabularyCache.dataVersion === currentDataVersion
    ) {
      return { terms: vocabularyCache.terms, rebuilt: false, dataVersion: currentDataVersion };
    }
    const rows = db.query('SELECT name, content FROM memories').all() as {
      name: string;
      content: string;
    }[];
    const terms = foldedVocabulary(rows);
    vocabularyCache = { generation, dataVersion: currentDataVersion, terms };
    return { terms, rebuilt: true, dataVersion: currentDataVersion };
  }

  /** Read a memory's stored embedding, or null when it has none. */
  function readEmbedding(id: string): Float32Array | null {
    const row = db
      .query('SELECT embedding FROM memories m JOIN spaces s ON s.id = m.space_id WHERE m.id = ?')
      .get(id) as any;
    return row?.embedding ? blobToVector(row.embedding) : null;
  }

  /**
   * LIKE channel: substring match over the query's sub-trigram tokens.
   *
   * Kept only for terms the trigram channel cannot index (length <
   * {@link TRIGRAM_MIN_LENGTH}), where LIKE adds recall; for longer terms the
   * trigram channel supersedes it and this channel stays empty.
   */
  function runLikeTokens(
    tokens: string[],
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): SearchRow[] {
    const clauses = tokens.map(() => '(m.name LIKE ? OR m.content LIKE ?)').join(' OR ');
    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at
            FROM memories m
            JOIN spaces s ON s.id = m.space_id
            WHERE (${clauses})
        `;
    const params: any[] = tokens.flatMap(token => [`%${token}%`, `%${token}%`]);

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    sql += tierFilter.sql;
    params.push(...tierFilter.params);

    sql += ' ORDER BY m.changed_at DESC, m.rowid DESC';

    let rows = db.query(sql).all(...params) as Omit<SearchRow, 'rank'>[];
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }
    return rows.map(row => ({ ...row, rank: 0 }));
  }

  /**
   * Every memory matching the filter, seeding the semantic channel. Rows
   * without a stored embedding are included but contribute no cosine score
   * (the semantic scorer skips null embeddings).
   */
  function querySemanticCandidateRows(filter?: {
    space?: string;
    tag?: string;
    tier?: Tier;
  }): SearchRow[] {
    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at
            FROM memories m
            JOIN spaces s ON s.id = m.space_id
            WHERE 1=1
        `;
    const params: any[] = [];
    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    sql += tierFilter.sql;
    params.push(...tierFilter.params);

    let rows = db.query(sql).all(...params) as Omit<SearchRow, 'rank'>[];
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }
    return rows.map(row => ({ ...row, rank: 0 }));
  }

  /**
   * Top-{@link SEMANTIC_TOP_K} cosine similarities at/above
   * {@link SEMANTIC_CANDIDATE_FLOOR}, keyed by memory id.
   */
  async function semanticScoresForQuery(
    query: string,
    candidates: SearchRow[]
  ): Promise<Map<string, number>> {
    const ids = candidates.map(candidate => candidate.id);
    if (ids.length === 0) return new Map();

    const scored = await semanticSearch(query, readEmbedding, ids);
    const ranked = scored
      .filter(entry => Number.isFinite(entry.score) && entry.score >= SEMANTIC_CANDIDATE_FLOOR)
      .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id))
      .slice(0, SEMANTIC_TOP_K);

    return new Map(ranked.map(entry => [entry.id, entry.score]));
  }

  /** Attach the fused score, confidence bucket and provenance to a result. */
  function toScoredSearchResult(entry: FusedCandidate<SearchRow>): ScoredSearchResult {
    return {
      ...toSearchResult(entry.item, entry.semanticScore),
      score: entry.score,
      confidence: entry.confidence,
      methods: entry.methods,
    };
  }

  async function searchMemories(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[]; semantic?: boolean }
  ): Promise<ScoredSearchResult[]> {
    const ast = parseQuery(query);
    // A supplied search with no informative positive terms is a caller
    // validation error, never an empty result. Check before the empty-AST
    // return and before any lexical or semantic channel runs.
    if (!hasInformativeQueryTerms(ast)) throw new EmptySearchQueryError();
    if (isEmptyQuery(ast)) return [];

    const rungs = buildRungs(ast);
    if (rungs.length === 0) return [];

    // True parallel retrieval (D3/D4): every channel collects candidates
    // independently with provenance, then fusion normalizes and combines them.
    // Coverage floors survive as *admission* guards that keep known-noisy
    // channels (relaxed `any` for multi-word AND queries, trigram/fuzzy
    // substrings) from injecting unrelated documents; they are no longer
    // mutual-exclusion gates between stronger and weaker channels.
    const broadRecall = isNaturalLanguageRecall(ast);
    const originalTokens = eligibleTokens(ast);
    const queryTokens = broadRecall ? informativeSearchTokens(originalTokens) : originalTokens;
    if (broadRecall && queryTokens.length === 0) return [];
    const enforceCoverage = !broadRecall && ast.groups.length === 1 && queryTokens.length >= 2;
    const coverageFloorTokens = broadRecall ? 1 : coverageFloor(queryTokens.length);

    const diagnostics = activeDiagnosticsSink();
    const diagnosticsStart = diagnostics ? performance.now() : 0;
    const channelDiagnostics: SearchChannelDiagnostic[] = [];
    let fuzzyExpansions = 0;
    let fuzzyCacheRebuilt = false;
    let fuzzyCacheDataVersion = 0;

    // `rowsById` is the union of every channel; `lexicalRowsById` is the
    // lexical-only view that admission and `token_set` must use. Keeping the
    // views separate freezes lexical admission/scoring when semantic ids are
    // present: semantic ids are unioned only after the lexical ladder.
    const rowsById = new Map<string, SearchRow>();
    const lexicalRowsById = new Map<string, SearchRow>();
    const channels: ChannelScores[] = [];
    const addChannel = (method: SearchChannelMethod, scores: Map<string, number>): void => {
      if (scores.size > 0) channels.push({ method, scores });
    };

    // NOT exclusions apply to *every* channel, including trigram/fuzzy/semantic
    // which do not carry the FTS NOT clause themselves.
    const excludedIds = new Set<string>();
    if (ast.exclude.length > 0) {
      const parts = ast.exclude.map(node =>
        node.type === 'phrase'
          ? `"${node.text.replace(/"/g, '')}"`
          : node.prefix
            ? `"${node.token}"*`
            : `"${node.token}"`
      );
      const match = parts.join(' OR ');
      if (match) {
        for (const row of runMatchQuery(match, filter)) excludedIds.add(row.id);
      }
    }

    // Lexical rungs: phrase → all → any.
    for (const rung of rungs) {
      const channelStart = diagnostics ? performance.now() : 0;
      const match =
        broadRecall && rung.method === 'any' ? buildInformativeAnyMatch(queryTokens) : rung.match;
      let rows = runMatchQuery(match, filter);
      if (rung.method === 'any' && enforceCoverage) {
        rows = rows.filter(
          row => matchedTokenCount(queryTokens, row.name, row.content) >= coverageFloorTokens
        );
      }
      const scores = new Map<string, number>();
      for (const row of rows) {
        rowsById.set(row.id, row);
        lexicalRowsById.set(row.id, row);
        scores.set(row.id, -Number(row.rank) || 0);
      }
      addChannel(rung.method as SearchChannelMethod, scores);
      if (diagnostics) {
        channelDiagnostics.push({
          channel: rung.method as SearchChannelMethod,
          ms: performance.now() - channelStart,
          candidates: scores.size,
        });
      }
    }

    // Trigram substring — terms shorter than 3 chars skip by design.
    const trigramTokens = queryTokens.filter(token => token.length >= TRIGRAM_MIN_LENGTH);
    if (trigramTokens.length > 0) {
      const channelStart = diagnostics ? performance.now() : 0;
      const match = trigramTokens.map(token => `"${token}"`).join(' OR ');
      const rows = runTrigramMatch(match, filter).filter(
        row => substringCoverage(queryTokens, row.name, row.content) >= coverageFloorTokens
      );
      const scores = new Map<string, number>();
      for (const row of rows) {
        rowsById.set(row.id, row);
        lexicalRowsById.set(row.id, row);
        scores.set(row.id, -Number(row.rank) || 0);
      }
      addChannel('trigram', scores);
      if (diagnostics) {
        channelDiagnostics.push({
          channel: 'trigram',
          ms: performance.now() - channelStart,
          candidates: scores.size,
        });
      }
    }

    // Fuzzy — banded OSA ≤2 over the cached folded document vocabulary (P-A),
    // with the documented prefix-3 rule restored. The full cached vocabulary
    // replaces the old query-dependent, unordered `LIMIT 2000` prefilter (no
    // truncation, deterministic), so only the prefix-3 requirement (not the
    // candidate selection) bounds recall. Coverage re-folds the candidate's
    // name + content with the shared engine fold.
    if (queryTokens.length > 0) {
      const channelStart = diagnostics ? performance.now() : 0;
      const vocabulary = globalVocabulary();
      fuzzyCacheRebuilt = vocabulary.rebuilt;
      fuzzyCacheDataVersion = vocabulary.dataVersion;
      const expansions = expandFuzzyTokens(queryTokens, vocabulary.terms);
      const expandedTerms = [...new Set([...expansions.values()].flat())].sort();
      fuzzyExpansions = expandedTerms.length;
      let fuzzyCandidates = 0;
      if (expandedTerms.length > 0) {
        const match = expandedTerms.map(term => `"${term}"`).join(' OR ');
        const rows = runMatchQuery(match, filter).filter(
          row =>
            fuzzyCoverage(queryTokens, expansions, row.name, row.content) >= coverageFloorTokens
        );
        const scores = new Map<string, number>();
        for (const row of rows) {
          rowsById.set(row.id, row);
          lexicalRowsById.set(row.id, row);
          scores.set(row.id, -Number(row.rank) || 0);
        }
        addChannel('fuzzy', scores);
        fuzzyCandidates = scores.size;
      }
      if (diagnostics) {
        channelDiagnostics.push({
          channel: 'fuzzy',
          ms: performance.now() - channelStart,
          candidates: fuzzyCandidates,
        });
      }
    }

    // LIKE — only for sub-trigram tokens, where the trigram channel cannot index.
    const shortTokens = queryTokens.filter(
      token => token.length > 0 && token.length < TRIGRAM_MIN_LENGTH
    );
    if (shortTokens.length > 0) {
      const channelStart = diagnostics ? performance.now() : 0;
      const rows = runLikeTokens(shortTokens, filter);
      const scores = new Map<string, number>();
      for (const row of rows) {
        rowsById.set(row.id, row);
        lexicalRowsById.set(row.id, row);
        scores.set(row.id, matchedTokenCount(shortTokens, row.name, row.content));
      }
      addChannel('like', scores);
      if (diagnostics) {
        channelDiagnostics.push({
          channel: 'like',
          ms: performance.now() - channelStart,
          candidates: scores.size,
        });
      }
    }

    // Semantic — RAG only; skipped when the breaker is open after a failure, or
    // when the caller explicitly opts out with `semantic: false` (web default
    // once the embeddings toggle is off). These ids feed `rowsById` (for
    // fusion) but never the lexical view, so the admission ladder and
    // `token_set` cannot be influenced by them.
    let semanticScores = new Map<string, number>();
    if (filter?.semantic !== false && isRagEnabled() && !isSemanticBreakerOpen()) {
      const channelStart = diagnostics ? performance.now() : 0;
      try {
        const candidateRows = querySemanticCandidateRows(filter);
        semanticScores = await semanticScoresForQuery(query, candidateRows);
        if (semanticScores.size > 0) {
          const byId = new Map(candidateRows.map(row => [row.id, row]));
          for (const id of semanticScores.keys()) {
            const row = byId.get(id);
            if (row) rowsById.set(row.id, row);
          }
          addChannel('semantic', semanticScores);
        }
        if (diagnostics) {
          channelDiagnostics.push({
            channel: 'semantic',
            ms: performance.now() - channelStart,
            candidates: semanticScores.size,
          });
        }
      } catch {
        recordSemanticFailure();
      }
    }

    // Token-set coverage: a scoring channel over the lexical candidates only.
    // Admitting semantic ids here would change lexical normalization and fused
    // scores, so semantic rows are deliberately excluded from this view.
    if (queryTokens.length > 0 && lexicalRowsById.size > 0) {
      const channelStart = diagnostics ? performance.now() : 0;
      const scores = new Map<string, number>();
      for (const row of lexicalRowsById.values()) {
        const coverage = tokenSetScore(queryTokens, tokenize(`${row.name} ${row.content}`));
        if (coverage > 0) scores.set(row.id, coverage);
      }
      addChannel('token_set', scores);
      if (diagnostics) {
        channelDiagnostics.push({
          channel: 'token_set',
          ms: performance.now() - channelStart,
          candidates: scores.size,
        });
      }
    }

    if (channels.length === 0 || rowsById.size === 0) return [];

    if (excludedIds.size > 0) {
      for (const id of excludedIds) {
        rowsById.delete(id);
        lexicalRowsById.delete(id);
        for (const channel of channels) channel.scores.delete(id);
      }
    }

    // Plain-language recall ranks all informative lexical matches. The older
    // all-terms-first gate could silently discard complementary evidence.
    // Explicit searches preserve their strict admission ladder.
    let finalRows = new Map<string, SearchRow>();
    if (broadRecall) {
      finalRows = new Map(lexicalRowsById);
    } else {
      for (const [id, row] of lexicalRowsById) {
        if (documentSatisfiesQuery(ast, row.name, row.content)) finalRows.set(id, row);
      }
      if (finalRows.size === 0 && queryTokens.length >= 2) {
        const floor = coverageFloor(queryTokens.length);
        for (const [id, row] of lexicalRowsById) {
          if (countCoveredQueryTokens(queryTokens, row.name, row.content) >= floor)
            finalRows.set(id, row);
        }
      }
      if (finalRows.size === 0) finalRows = new Map(lexicalRowsById);
    }

    // Independent semantic admission: for natural-language queries (single
    // plain-term group, no NOT), a semantic candidate at/above the stricter
    // floor reaches fusion even when lexical admission already succeeded. Ids
    // absent from `rowsById` failed the space/tier/tag filters and are skipped.
    let semanticAdmitted = 0;
    if (canBypassLexicalAdmission(ast)) {
      for (const id of selectSemanticAdmittedIds(semanticScores, excludedIds)) {
        const row = rowsById.get(id);
        if (row) {
          finalRows.set(id, row);
          semanticAdmitted += 1;
        }
      }
    }
    if (finalRows.size === 0) return [];

    const keptIds = new Set(finalRows.keys());
    const keptChannels = channels
      .map(channel => ({
        method: channel.method,
        scores: new Map([...channel.scores].filter(([id]) => keptIds.has(id))),
      }))
      .filter(channel => channel.scores.size > 0);

    const fused = fuseCandidates([...finalRows.values()], keptChannels).map(toScoredSearchResult);
    if (diagnostics) {
      diagnostics({
        channels: channelDiagnostics,
        fuzzy_expansions: fuzzyExpansions,
        fuzzy_cache_rebuilt: fuzzyCacheRebuilt,
        data_version: fuzzyCacheDataVersion,
        admission: {
          kept: finalRows.size,
          dropped: rowsById.size - finalRows.size,
          semantic_admitted: semanticAdmitted,
        },
        total_candidates: rowsById.size,
        total_ms: performance.now() - diagnosticsStart,
      });
    }
    return fused;
  }

  async function searchFallback(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<{ results: SearchResult[]; search_method: string }> {
    // Step 1: Try FTS5
    let ftsResults = await searchFts5(query, filter);
    if (ftsResults.length > 0) {
      return { results: ftsResults, search_method: 'fts5' };
    }

    // Step 2: FTS returned nothing — try LIKE fallback
    let likeResults = searchLike(query, filter);
    if (likeResults.length > 0) {
      return { results: likeResults, search_method: 'like' };
    }

    // Step 3: If RAG enabled, try embeddings fallback
    if (isRagEnabled()) {
      const semanticResults = await searchSemantic(query, filter);
      if (semanticResults.length > 0) {
        return { results: semanticResults, search_method: 'embeddings' };
      }
    }

    return { results: [], search_method: 'fts5' };
  }

  async function searchFts5(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<SearchResult[]> {
    const ast = parseQuery(query);
    if (isEmptyQuery(ast)) return [];

    const match = buildPrimaryMatch(ast);
    if (!match) return [];

    return runMatchQuery(match, filter).map(row => toSearchResult(row));
  }

  function searchLike(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): SearchResult[] {
    // Simple LIKE-based search as fallback when FTS5 returns nothing
    const likePattern = `%${query}%`;

    let sql = `
            SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned,
                   m.created_at, m.updated_at, m.changed_at
            FROM memories m
            JOIN spaces s ON s.id = m.space_id
            WHERE (m.name LIKE ? OR m.content LIKE ?)
        `;
    const params: any[] = [likePattern, likePattern];

    if (filter?.space) {
      sql += ' AND s.name = ?';
      params.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    sql += tierFilter.sql;
    params.push(...tierFilter.params);

    sql += ' ORDER BY m.changed_at DESC, m.rowid DESC';

    let rows = db.query(sql).all(...params) as Omit<SearchRow, 'rank'>[];

    // Post-filter by tag
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      rows = rows.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }

    return rows.map(row => toSearchResult({ ...row, rank: 0 }));
  }

  async function searchSemantic(
    query: string,
    filter?: { space?: string; tag?: string; tier?: Tier; tiers?: Tier[] }
  ): Promise<SearchResult[]> {
    if (!isRagEnabled()) return [];

    const SEMANTIC_FALLBACK_THRESHOLD = 0.3;

    let candSql =
      'SELECT m.id, s.name as space_name, m.name, m.content, m.tier, m.pinned, m.created_at, m.updated_at, m.changed_at FROM memories m JOIN spaces s ON s.id = m.space_id WHERE 1=1';
    const candParams: any[] = [];
    if (filter?.space) {
      candSql += ' AND s.name = ?';
      candParams.push(filter.space);
    }
    const tierFilter = tierClause(filter);
    candSql += tierFilter.sql;
    candParams.push(...tierFilter.params);
    let candidates = db.query(candSql).all(...candParams) as SearchRow[];
    if (filter?.tag) {
      const normalizedTag = normalizeTag(filter.tag);
      candidates = candidates.filter(r => getTagsForMemory(db, r.id).includes(normalizedTag));
    }

    const allIds = candidates.map(r => r.id);
    const semanticResults = await semanticSearch(query, readEmbedding, allIds);
    const goodResults = semanticResults.filter(sr => sr.score >= SEMANTIC_FALLBACK_THRESHOLD);
    if (goodResults.length === 0) return [];

    const idToMem = new Map(candidates.map(r => [r.id, r]));
    return goodResults.map(sr => toSearchResult(idToMem.get(sr.id)!, sr.score));
  }

  function queryMemories(filter?: MemoryQueryFilter): MemorySummary[] {
    let sql =
      'SELECT m.id, s.name as space_name, m.space_id, m.name, m.tier, m.pinned, m.access_count, m.created_at, m.updated_at, m.changed_at FROM memories m JOIN spaces s ON s.id = m.space_id';
    const joinParams: any[] = [];
    const conditions: string[] = [];
    const whereParams: any[] = [];

    if (filter?.tag) {
      sql += ' JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = ?';
      joinParams.push(normalizeTag(filter.tag));
    }

    if (filter?.space) {
      conditions.push('s.name = ?');
      whereParams.push(filter.space);
    }

    if (filter?.tiers && filter.tiers.length > 0) {
      conditions.push(`m.tier IN (${filter.tiers.map(() => '?').join(',')})`);
      whereParams.push(...filter.tiers);
    } else if (filter?.tier !== undefined) {
      conditions.push('m.tier = ?');
      whereParams.push(filter.tier);
    }

    if (filter?.from) {
      conditions.push('m.changed_at >= ?');
      whereParams.push(normalizeDateBound(filter.from, false));
    }

    if (filter?.to) {
      conditions.push('m.changed_at <= ?');
      whereParams.push(normalizeDateBound(filter.to, true));
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const limit = Math.max(1, Math.min(500, filter?.limit ?? 25));
    const offset = Math.max(0, filter?.offset ?? 0);

    sql += ' ORDER BY m.changed_at DESC, m.rowid DESC LIMIT ? OFFSET ?';
    const rows = db.query(sql).all(...joinParams, ...whereParams, limit, offset) as any[];

    return rows.map(r => ({
      id: r.id,
      space_id: r.space_id,
      space_name: r.space_name,
      name: r.name,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      access_count: r.access_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  async function queryMemoriesCount(filter: {
    space?: string;
    tag?: string;
    tier?: number;
    tiers?: Tier[];
    from?: string;
    to?: string;
  }): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM memories m JOIN spaces s ON s.id = m.space_id';
    const joinParams: any[] = [];
    const conditions: string[] = [];
    const whereParams: any[] = [];

    if (filter?.tag) {
      sql += ' JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = ?';
      joinParams.push(normalizeTag(filter.tag));
    }

    if (filter?.space) {
      conditions.push('s.name = ?');
      whereParams.push(filter.space);
    }

    if (filter?.tiers && filter.tiers.length > 0) {
      conditions.push(`m.tier IN (${filter.tiers.map(() => '?').join(',')})`);
      whereParams.push(...filter.tiers);
    } else if (filter?.tier !== undefined) {
      conditions.push('m.tier = ?');
      whereParams.push(filter.tier);
    }

    if (filter?.from) {
      conditions.push('m.changed_at >= ?');
      whereParams.push(normalizeDateBound(filter.from, false));
    }

    if (filter?.to) {
      conditions.push('m.changed_at <= ?');
      whereParams.push(normalizeDateBound(filter.to, true));
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const row = db.query(sql).get(...joinParams, ...whereParams) as { count: number };
    return row.count;
  }

  /**
   * Bounded summary query shared by space orientation surfaces. Applies every
   * filter, the exclusion, ordering and the limit in SQL so a tier is never
   * materialized just to preview a handful of memories.
   */
  function queryBoundedMemorySummaries(options: {
    space: string;
    tier?: Tier;
    requiredTags?: string[];
    excludeTag?: string;
    limit: number;
  }): BoundedMemorySummaryResult {
    const params: any[] = [options.space];
    const conditions: string[] = ['s.name = ?'];

    if (options.tier !== undefined) {
      conditions.push('m.tier = ?');
      params.push(options.tier);
    }

    for (const tag of options.requiredTags ?? []) {
      conditions.push(
        'EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = ?)'
      );
      params.push(normalizeTag(tag));
    }

    if (options.excludeTag) {
      conditions.push(
        'NOT EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = ?)'
      );
      params.push(normalizeTag(options.excludeTag));
    }

    const where = conditions.join(' AND ');
    const limit = Math.max(0, Math.trunc(options.limit));

    const totalRow = db
      .query(
        `SELECT COUNT(*) as count
         FROM memories m
         JOIN spaces s ON s.id = m.space_id
         WHERE ${where}`
      )
      .get(...params) as { count: number };

    const rows = db
      .query(
        `SELECT m.id, s.name as space_name, m.space_id, m.name, m.tier, m.pinned,
                m.access_count, m.created_at, m.updated_at, m.changed_at
         FROM memories m
         JOIN spaces s ON s.id = m.space_id
         WHERE ${where}
         ORDER BY m.pinned DESC, m.changed_at DESC, m.rowid DESC
         LIMIT ?`
      )
      .all(...params, limit) as any[];

    return {
      total_count: totalRow.count,
      memories: rows.map(r => ({
        id: r.id,
        space_id: r.space_id,
        space_name: r.space_name,
        name: r.name,
        tier: r.tier as Tier,
        pinned: r.pinned === 1,
        tags: getTagsForMemory(db, r.id),
        access_count: r.access_count,
        created_at: r.created_at,
        updated_at: r.updated_at,
        changed_at: r.changed_at,
      })),
    };
  }

  function getTrendingMemories(
    space: string,
    tier: Tier,
    limit: number
  ): BoundedMemorySummaryResult {
    return queryBoundedMemorySummaries({ space, tier, excludeTag: 'checkpoint', limit });
  }

  function getLivingReferences(space: string, limit: number): BoundedMemorySummaryResult {
    return queryBoundedMemorySummaries({
      space,
      requiredTags: ['type:reference', 'status:living'],
      excludeTag: 'checkpoint',
      limit,
    });
  }

  function getSpaceGraph(
    space: string,
    opts?: { limit?: number; maxLimit?: number }
  ): {
    nodes: { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }[];
    meta: {
      total_nodes: number;
      returned_nodes: number;
      requested_limit: number;
      applied_limit: number;
      max_limit: number;
      truncated: boolean;
    };
  } {
    const spaceRow = db.query('SELECT 1 FROM spaces WHERE name = ?').get(space);
    if (!spaceRow)
      throw new Error(`Space "${space}" does not exist. Create it first with space_create tool.`);

    const requestedLimit = opts?.limit ?? 300;
    const maxLimit = opts?.maxLimit ?? 1000;
    const normalizedRequestedLimit = Math.max(1, Math.trunc(requestedLimit));
    const appliedLimit = Math.min(normalizedRequestedLimit, Math.max(1, Math.trunc(maxLimit)));

    const totalRow = db
      .query(
        'SELECT COUNT(*) as total FROM memories m JOIN spaces s ON s.id = m.space_id WHERE s.name = ? AND m.tier < 4'
      )
      .get(space) as {
      total: number;
    };
    const totalNodes = totalRow.total;

    const rows = db
      .query(
        `SELECT m.id, m.name, m.tier
                 FROM memories m
                 JOIN spaces s ON s.id = m.space_id
                 WHERE s.name = ? AND m.tier < 4
                 ORDER BY m.tier ASC, m.access_count DESC, m.name ASC
                 LIMIT ?`
      )
      .all(space, appliedLimit) as { id: string; name: string; tier: Tier }[];

    const nodeMap = new Map<
      string,
      { id: string; name: string; tier: Tier; links_to: string[]; linked_by: string[] }
    >(
      rows.map(row => [
        row.id,
        { id: row.id, name: row.name, tier: row.tier, links_to: [], linked_by: [] },
      ])
    );

    if (rows.length > 0) {
      const selectedIds = rows.map(row => row.id);
      const placeholders = selectedIds.map(() => '?').join(',');
      const params = [space, space, ...selectedIds, ...selectedIds];

      const linkRows = db
        .query(
          `SELECT l.source_id, l.target_id
                     FROM links l
                     JOIN memories sm ON sm.id = l.source_id
                     JOIN spaces ss ON ss.id = sm.space_id
                     JOIN memories tm ON tm.id = l.target_id
                     JOIN spaces ts ON ts.id = tm.space_id
                     WHERE ss.name = ?
                       AND ts.name = ?
                       AND (l.source_id IN (${placeholders}) OR l.target_id IN (${placeholders}))`
        )
        .all(...params) as { source_id: string; target_id: string }[];

      for (const linkRow of linkRows) {
        const sourceNode = nodeMap.get(linkRow.source_id);
        if (sourceNode) sourceNode.links_to.push(linkRow.target_id);

        const targetNode = nodeMap.get(linkRow.target_id);
        if (targetNode) targetNode.linked_by.push(linkRow.source_id);
      }

      for (const node of nodeMap.values()) {
        node.links_to.sort();
        node.linked_by.sort();
      }
    }

    const nodes = rows.map(row => nodeMap.get(row.id)!);

    return {
      nodes,
      meta: {
        total_nodes: totalNodes,
        returned_nodes: nodes.length,
        requested_limit: normalizedRequestedLimit,
        applied_limit: appliedLimit,
        max_limit: Math.max(1, Math.trunc(maxLimit)),
        truncated: nodes.length < totalNodes,
      },
    };
  }

  return {
    searchMemories,
    searchFallback,
    searchFts5,
    searchLike,
    searchSemantic,
    queryMemories,
    queryMemoriesCount,
    getTrendingMemories,
    getLivingReferences,
    getSpaceGraph,
  };
}
