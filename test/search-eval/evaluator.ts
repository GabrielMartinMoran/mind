// ── Evaluation runner: executes cases against an engine and aggregates ──
//
// The runner is engine-agnostic: it receives a `SearchFn` that maps a query +
// params to an ordered list of memory refs. Fixture mode wires this to a
// throwaway store seeded from the committed corpus; real mode wires it to the
// read-only search repository over a DB copy.

import { Database } from 'bun:sqlite';

import {
  createLinkRepository,
  createMemoryRepository,
  createSearchRepository,
  createSpaceRepository,
  createTagRepository,
} from '../../src/store/repositories';
import { FtsHelper } from '../../src/store/shared';

import { buildFixtureCases } from './cases';
import { buildV2Cases } from './cases.expanded';
import { FIXTURE_CORPUS, FIXTURE_SPACES, listFixtureSpaces } from './corpus';
import { V2_CORPUS, listV2Spaces } from './corpus.expanded';
import { stableHash } from './hash';
import {
  DEFAULT_K,
  aggregateBy,
  aggregateVerdicts,
  computeVerdict,
  type CaseVerdict,
  type SegmentMetrics,
} from './metrics';
import {
  NDCG_K,
  computeRankingMetrics,
  ndcgAtK,
  reciprocalRank,
  type RankingMetrics,
} from './ranking-metrics';
import { dedupeRefs, refOf } from './refs';
import type { CaseParams, EvalCase, RealCase } from './types';

/** Maps a query + params to an ordered list of memory refs. */
export interface SearchFn {
  (query: string, params: CaseParams): Promise<string[]>;
}

export interface CaseReport {
  id: string;
  level: string;
  origin: string;
  type: string;
  realShape: boolean;
  query: string;
  space: string | null;
  tier: number | null;
  tag: string | null;
  k: number;
  result_count: number;
  topk: string[];
  expected_count: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  passed: boolean;
  noise: boolean;
  errored: boolean;
  error?: string;
}

export interface RunReport {
  schema: 'search-eval-report/v1';
  k_default: number;
  case_count: number;
  errored_cases: number;
  metrics: {
    overall: SegmentMetrics;
    by_origin: Record<string, SegmentMetrics>;
    by_level: Record<string, SegmentMetrics>;
    by_type: Record<string, SegmentMetrics>;
  };
  cases: CaseReport[];
}

export interface FixtureSnapshot extends Omit<RunReport, 'schema'> {
  schema: 'search-eval-baseline/v1';
  hash: string;
}

function toCaseReport(
  verdict: CaseVerdict,
  evalCase: EvalCase,
  resultCount: number,
  error?: string
): CaseReport {
  return {
    id: verdict.id,
    level: evalCase.level,
    origin: evalCase.origin,
    type: evalCase.type,
    realShape: evalCase.realShape === true,
    query: evalCase.query,
    space: evalCase.params.space ?? null,
    tier: evalCase.params.tier ?? null,
    tag: evalCase.params.tag ?? null,
    k: verdict.k,
    result_count: resultCount,
    topk: verdict.topK,
    expected_count: verdict.expected.length,
    tp: verdict.tp,
    fp: verdict.fp,
    fn: verdict.fn,
    precision: verdict.precision,
    recall: verdict.recall,
    passed: verdict.passed,
    noise: verdict.noise,
    errored: error !== undefined,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Run every case through the engine and aggregate metrics.
 *
 * An engine exception is a legitimate outcome to measure: it is caught and
 * recorded as an errored, zero-result case rather than aborting the run.
 */
export async function runSuite(
  cases: EvalCase[],
  searchFn: SearchFn,
  options: { defaultK?: number } = {}
): Promise<RunReport> {
  const defaultK = options.defaultK ?? DEFAULT_K;
  const byId = new Map(cases.map(evalCase => [evalCase.id, evalCase]));
  const verdicts: CaseVerdict[] = [];
  const reports: CaseReport[] = [];

  for (const evalCase of cases) {
    let refs: string[] = [];
    let error: string | undefined;
    try {
      refs = await searchFn(evalCase.query, evalCase.params);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    // An errored case yields no refs, so it contributes no FP and cannot be
    // "noise"; it is surfaced separately (errored_cases + per-case `errored`).
    const verdict = computeVerdict(refs, evalCase, defaultK);
    verdicts.push(verdict);
    reports.push(toCaseReport(verdict, evalCase, refs.length, error));
  }

  const metrics = {
    overall: aggregateVerdicts(verdicts),
    by_origin: aggregateBy(verdicts, v => byId.get(v.id)!.origin),
    by_level: aggregateBy(verdicts, v => byId.get(v.id)!.level),
    by_type: aggregateBy(verdicts, v => byId.get(v.id)!.type),
  };

  return {
    schema: 'search-eval-report/v1',
    k_default: defaultK,
    case_count: cases.length,
    errored_cases: reports.filter(report => report.errored).length,
    metrics,
    cases: reports,
  };
}

/** Build the deterministic baseline snapshot (metrics + per-case results + hash). */
export function buildSnapshot(report: RunReport): FixtureSnapshot {
  const core = {
    k_default: report.k_default,
    case_count: report.case_count,
    errored_cases: report.errored_cases,
    metrics: report.metrics,
    cases: report.cases,
  };
  return {
    schema: 'search-eval-baseline/v1',
    ...core,
    hash: stableHash(core),
  };
}

/** Seed a throwaway store from the committed fixture corpus. */
export async function seedFixtureStore(): Promise<
  Awaited<ReturnType<typeof import('../mocks/test-store').createTestStore>>
> {
  const { createTestStore } = await import('../mocks/test-store');
  const store = createTestStore();
  for (const space of listFixtureSpaces()) {
    store.createSpace(space, 'search-eval fixture space', ['type:eval']);
  }
  for (const doc of FIXTURE_CORPUS) {
    await store.addMemory(doc.space, doc.name, doc.content, { tags: doc.tags, tier: doc.tier });
  }
  return store;
}

/** Run the fixture suite against the current engine and return snapshot + report. */
export async function runFixture(
  options: { defaultK?: number } = {}
): Promise<{ snapshot: FixtureSnapshot; report: RunReport }> {
  const store = await seedFixtureStore();
  try {
    const cases = buildFixtureCases();
    const searchFn: SearchFn = async (query, params) => {
      const results = await store.search(query, {
        space: params.space,
        tier: params.tier,
        tag: params.tag,
      });
      return results.map(result => refOf(result.space_name, result.name));
    };
    const report = await runSuite(cases, searchFn, options);
    return { snapshot: buildSnapshot(report), report };
  } finally {
    store.cleanup();
  }
}

// ── Real-DB (read-only) mode ──

export interface RealCaseResult {
  id: string;
  query: string;
  space: string | null;
  presence: string;
  scan_hit_count: number;
  result_count: number;
  topk: string[];
  tp: number;
  fp: number;
  fn: number;
  passed: boolean;
  /** The engine threw on this query (excluded from FP/noise math). */
  errored: boolean;
}

export interface PresenceBreakdown {
  queries: number;
  zero_result: number;
  with_result: number;
  errored: number;
}

export interface RealRunReport {
  schema: 'search-eval-real/v1';
  db_path: string;
  case_count: number;
  zero_result_queries: number;
  errored_cases: number;
  by_presence: Record<string, PresenceBreakdown>;
  cases: RealCaseResult[];
}

function realCaseToEvalCase(realCase: RealCase): EvalCase {
  return {
    id: realCase.id,
    query: realCase.query,
    params: realCase.params,
    expected: realCase.expected,
    level: 'N1',
    origin: 'lab',
    type: 'exact',
    notes: realCase.notes,
  };
}

/**
 * Run curated real cases against the real DB copy in strict read-only mode.
 * The DB path must point at a COPY (never the live `data/mind.db`).
 */
export async function runReal(dbPath: string, realCases: RealCase[]): Promise<RealRunReport> {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Build the repository chain the same way the store does, so this exercises
    // the real search code with fully typed collaborators (no `as never`).
    const fts = new FtsHelper(db);
    const tagRepo = createTagRepository(db);
    const linkRepo = createLinkRepository(db);
    const spaceRepo = createSpaceRepository(db, fts);
    const memoryRepo = createMemoryRepository(db, spaceRepo, tagRepo, linkRepo, fts);
    const repo = createSearchRepository(db, memoryRepo, tagRepo);

    const byPresence: Record<string, PresenceBreakdown> = {};
    const cases: RealCaseResult[] = [];
    let zeroResultQueries = 0;
    let erroredCases = 0;

    for (const realCase of realCases) {
      const evalCase = realCaseToEvalCase(realCase);
      let results: Awaited<ReturnType<typeof repo.searchMemories>> = [];
      let errored = false;
      try {
        results = await repo.searchMemories(realCase.query, {
          space: realCase.params.space,
          tier: realCase.params.tier,
          tag: realCase.params.tag,
        });
      } catch {
        errored = true;
      }

      const breakdown = (byPresence[realCase.presence] ??= {
        queries: 0,
        zero_result: 0,
        with_result: 0,
        errored: 0,
      });
      breakdown.queries += 1;

      if (errored) {
        // Excluded from FP/noise math: an engine crash is reported separately.
        erroredCases += 1;
        breakdown.errored += 1;
        cases.push({
          id: realCase.id,
          query: realCase.query,
          space: realCase.space,
          presence: realCase.presence,
          scan_hit_count: realCase.scan_hit_count,
          result_count: 0,
          topk: [],
          tp: 0,
          fp: 0,
          fn: 0,
          passed: false,
          errored: true,
        });
        continue;
      }

      const refs = results.map(result => refOf(result.space_name, result.name));
      const verdict = computeVerdict(refs, evalCase);
      if (results.length === 0) {
        breakdown.zero_result += 1;
        zeroResultQueries += 1;
      } else {
        breakdown.with_result += 1;
      }

      cases.push({
        id: realCase.id,
        query: realCase.query,
        space: realCase.space,
        presence: realCase.presence,
        scan_hit_count: realCase.scan_hit_count,
        result_count: results.length,
        topk: verdict.topK,
        tp: verdict.tp,
        fp: verdict.fp,
        fn: verdict.fn,
        passed: verdict.passed,
        errored: false,
      });
    }

    return {
      schema: 'search-eval-real/v1',
      db_path: dbPath,
      case_count: cases.length,
      zero_result_queries: zeroResultQueries,
      errored_cases: erroredCases,
      by_presence: byPresence,
      cases,
    };
  } finally {
    db.close();
  }
}

export { FIXTURE_SPACES };

// ── v2 suite (versioned; additive, v1 output remains byte-identical) ──

/**
 * A richer engine row for the v2 suite. Carries the fused `score`, the
 * `confidence` bucket and channel `methods` provenance alongside the ref, so the
 * v2 snapshot can record ranking diagnostics that v1 deliberately omits.
 */
export interface SearchRowV2 {
  ref: string;
  methods: string[];
  confidence: string;
  score: number;
}

/** Maps a query + params to an ordered list of richer engine rows. */
export interface SearchFnV2 {
  (query: string, params: CaseParams): Promise<SearchRowV2[]>;
}

/** Per-result ranking diagnostics captured in the v2 snapshot. */
export interface RankedResultV2 {
  ref: string;
  methods: string[];
  confidence: string;
  score: number;
}

export interface CaseReportV2 {
  id: string;
  level: string;
  origin: string;
  type: string;
  realShape: boolean;
  query: string;
  space: string | null;
  tier: number | null;
  tag: string | null;
  k: number;
  result_count: number;
  topk: string[];
  results: RankedResultV2[];
  expected_count: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  passed: boolean;
  noise: boolean;
  errored: boolean;
  error?: string;
  /** Reciprocal rank of the first relevant ref (0 when none / no labels). */
  rr: number;
  /** nDCG@10 with binary relevance (0 when no labels). */
  ndcg_at_10: number;
}

export interface RunReportV2 {
  schema: 'search-eval-report/v2';
  k_default: number;
  case_count: number;
  errored_cases: number;
  ranking: RankingMetrics;
  metrics: {
    overall: SegmentMetrics;
    by_origin: Record<string, SegmentMetrics>;
    by_level: Record<string, SegmentMetrics>;
    by_type: Record<string, SegmentMetrics>;
  };
  cases: CaseReportV2[];
}

export interface FixtureSnapshotV2 extends Omit<RunReportV2, 'schema'> {
  schema: 'search-eval-baseline/v2';
  hash: string;
}

function dedupeSearchRows(rows: SearchRowV2[]): SearchRowV2[] {
  const seen = new Set<string>();
  const out: SearchRowV2[] = [];
  for (const row of rows) {
    if (seen.has(row.ref)) continue;
    seen.add(row.ref);
    out.push(row);
  }
  return out;
}

/**
 * Run every v2 case through the engine and aggregate metrics plus ranking. An
 * engine exception is recorded as an errored, zero-result case rather than
 * aborting the run (mirrors `runSuite`).
 */
export async function runSuiteV2(
  cases: EvalCase[],
  searchFn: SearchFnV2,
  options: { defaultK?: number } = {}
): Promise<RunReportV2> {
  const defaultK = options.defaultK ?? DEFAULT_K;
  const byId = new Map(cases.map(evalCase => [evalCase.id, evalCase]));
  const verdicts: CaseVerdict[] = [];
  const reports: CaseReportV2[] = [];
  const rankingRows: { topk: string[]; expected: string[] }[] = [];

  for (const evalCase of cases) {
    let rows: SearchRowV2[] = [];
    let error: string | undefined;
    try {
      rows = await searchFn(evalCase.query, evalCase.params);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const refs = dedupeRefs(rows.map(row => row.ref));
    const verdict = computeVerdict([...refs], evalCase, defaultK);
    const rowByRef = new Map(dedupeSearchRows(rows).map(row => [row.ref, row]));
    const results: RankedResultV2[] = verdict.topK.map(ref => {
      const row = rowByRef.get(ref);
      return {
        ref,
        methods: row ? [...row.methods] : [],
        confidence: row ? row.confidence : 'low',
        score: row ? row.score : 0,
      };
    });

    verdicts.push(verdict);
    rankingRows.push({ topk: verdict.topK, expected: evalCase.expected });

    reports.push({
      id: verdict.id,
      level: evalCase.level,
      origin: evalCase.origin,
      type: evalCase.type,
      realShape: evalCase.realShape === true,
      query: evalCase.query,
      space: evalCase.params.space ?? null,
      tier: evalCase.params.tier ?? null,
      tag: evalCase.params.tag ?? null,
      k: verdict.k,
      result_count: refs.length,
      topk: verdict.topK,
      results,
      expected_count: verdict.expected.length,
      tp: verdict.tp,
      fp: verdict.fp,
      fn: verdict.fn,
      precision: verdict.precision,
      recall: verdict.recall,
      passed: verdict.passed,
      noise: verdict.noise,
      errored: error !== undefined,
      ...(error !== undefined ? { error } : {}),
      rr: reciprocalRank(verdict.topK, evalCase.expected),
      ndcg_at_10: ndcgAtK(verdict.topK, evalCase.expected, NDCG_K),
    });
  }

  return {
    schema: 'search-eval-report/v2',
    k_default: defaultK,
    case_count: cases.length,
    errored_cases: reports.filter(report => report.errored).length,
    ranking: computeRankingMetrics(rankingRows, NDCG_K),
    metrics: {
      overall: aggregateVerdicts(verdicts),
      by_origin: aggregateBy(verdicts, v => byId.get(v.id)!.origin),
      by_level: aggregateBy(verdicts, v => byId.get(v.id)!.level),
      by_type: aggregateBy(verdicts, v => byId.get(v.id)!.type),
    },
    cases: reports,
  };
}

/** Build the deterministic v2 baseline snapshot (report + stable hash). */
export function buildSnapshotV2(report: RunReportV2): FixtureSnapshotV2 {
  const core = {
    k_default: report.k_default,
    case_count: report.case_count,
    errored_cases: report.errored_cases,
    ranking: report.ranking,
    metrics: report.metrics,
    cases: report.cases,
  };
  return {
    schema: 'search-eval-baseline/v2',
    ...core,
    hash: stableHash(core),
  };
}

/** Seed a throwaway store from the expanded v2 corpus. */
export async function seedV2Store(): Promise<
  Awaited<ReturnType<typeof import('../mocks/test-store').createTestStore>>
> {
  const { createTestStore } = await import('../mocks/test-store');
  const store = createTestStore();
  for (const space of listV2Spaces()) {
    store.createSpace(space, 'search-eval v2 fixture space', ['type:eval']);
  }
  for (const doc of V2_CORPUS) {
    await store.addMemory(doc.space, doc.name, doc.content, { tags: doc.tags, tier: doc.tier });
  }
  return store;
}

/** Run the v2 fixture suite against the current engine. */
export async function runFixtureV2(
  options: { defaultK?: number } = {}
): Promise<{ snapshot: FixtureSnapshotV2; report: RunReportV2 }> {
  const store = await seedV2Store();
  try {
    const cases = buildV2Cases();
    const searchFn: SearchFnV2 = async (query, params) => {
      const results = await store.search(query, {
        space: params.space,
        tier: params.tier,
        tag: params.tag,
      });
      return results.map(result => ({
        ref: refOf(result.space_name, result.name),
        methods: [...result.methods],
        confidence: result.confidence,
        score: result.score,
      }));
    };
    const report = await runSuiteV2(cases, searchFn, options);
    return { snapshot: buildSnapshotV2(report), report };
  } finally {
    store.cleanup();
  }
}
