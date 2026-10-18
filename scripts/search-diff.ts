#!/usr/bin/env bun
// ── Differential search tool (old-engine vs new-engine, per query) ──
//
// Two modes:
//
//   bun run scripts/search-diff.ts --emit <out.json>
//       Run the v2 fixture suite against the engine in the CURRENT directory and
//       write one JSON snapshot (per-case top-k + per-result provenance + the
//       aggregate quality metrics).
//
//   bun run scripts/search-diff.ts --compare <old.json> <new.json> --out <diff.json>
//       Compare two `--emit` snapshots per query: added / removed / reordered
//       refs, score and confidence changes, new false positives, fixed / lost
//       true positives, and aggregate metric deltas grouped by
//       origin / level / type.
//
// To diff two engines, run `--emit` once in each tree, then `--compare` here.
// The pre-optimization reference copy lives at
// `/tmp/opencode/search-optimization/old-engine/` (see the task report); a
// self-diff (old vs new with no engine change) must produce zero changes.

// Deterministic and offline: force RAG off BEFORE importing any module that
// reads CONFIG at import time (config.ts snapshots MIND_RAG when first loaded).
// ESM hoists static imports, so the app modules MUST be loaded with dynamic
// `await import(...)` after this assignment (mirrors scripts/search-eval.ts);
// a top-level assignment followed by static imports is silently ineffective.
process.env.MIND_RAG = 'false';

import type { CaseParams } from '../test/search-eval/types';

// ── Emit shape ──

export interface EmitResult {
  ref: string;
  methods: string[];
  confidence: string;
  score: number;
}

export interface EmitCase {
  id: string;
  query: string;
  params: CaseParams;
  expected: string[];
  topk: string[];
  results: EmitResult[];
  /** Union of result methods across top-k, sorted (case-level provenance). */
  methods: string[];
  /** Confidence of the top-ranked result. */
  confidence: string;
  /** Score of the top-ranked result. */
  score: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  rr: number;
  ndcg_at_10: number;
  level: string;
  origin: string;
  type: string;
}

export interface EmitAggregates {
  case_count: number;
  passed: number;
  tp: number;
  fp: number;
  fn: number;
  avg_precision: number;
  avg_recall: number;
  noise_rate: number;
  mrr: number;
  ndcg_at_10: number;
}

export interface EmitFile {
  schema: 'search-diff-emit/v1';
  /** Stable hash of the per-case payload (ignores timestamps). */
  engine_hash: string;
  k_default: number;
  aggregates: EmitAggregates;
  cases: EmitCase[];
}

/** Run the v2 fixture suite and build a deterministic emit snapshot. */
export async function buildEmit(): Promise<EmitFile> {
  // Loaded lazily so MIND_RAG (set above) is in effect before config.ts loads.
  const [{ runFixtureV2 }, { buildV2Cases }, { stableHash }] = await Promise.all([
    import('../test/search-eval/evaluator'),
    import('../test/search-eval/cases.expanded'),
    import('../test/search-eval/hash'),
  ]);
  const { report } = await runFixtureV2();
  const seeded = new Map(buildV2Cases().map(evalCase => [evalCase.id, evalCase]));

  const cases: EmitCase[] = report.cases.map(caseReport => {
    const source = seeded.get(caseReport.id);
    if (!source) throw new Error(`emit: no v2 case labelled ${caseReport.id}`);
    const results: EmitResult[] = caseReport.results.map(result => ({
      ref: result.ref,
      methods: [...result.methods],
      confidence: result.confidence,
      score: result.score,
    }));
    const methods = [...new Set(results.flatMap(result => result.methods))].sort();
    const top = results[0];
    return {
      id: caseReport.id,
      query: caseReport.query,
      params: source.params,
      expected: [...source.expected],
      topk: [...caseReport.topk],
      results,
      methods,
      confidence: top?.confidence ?? 'low',
      score: top?.score ?? 0,
      tp: caseReport.tp,
      fp: caseReport.fp,
      fn: caseReport.fn,
      precision: caseReport.precision,
      recall: caseReport.recall,
      rr: caseReport.rr,
      ndcg_at_10: caseReport.ndcg_at_10,
      level: caseReport.level,
      origin: caseReport.origin,
      type: caseReport.type,
    };
  });

  const overall = report.metrics.overall;
  const aggregates: EmitAggregates = {
    case_count: report.case_count,
    passed: overall.passed,
    tp: overall.tp,
    fp: overall.fp,
    fn: overall.fn,
    avg_precision: overall.avgPrecision,
    avg_recall: overall.avgRecall,
    noise_rate: overall.noiseRate,
    mrr: report.ranking.mrr,
    ndcg_at_10: report.ranking.ndcg_at_10,
  };

  return {
    schema: 'search-diff-emit/v1',
    engine_hash: stableHash(cases),
    k_default: report.k_default,
    aggregates,
    cases,
  };
}

// ── Compare shape ──

export interface RefChange {
  ref: string;
  methods: string[];
}

export interface RankChange {
  ref: string;
  old_rank: number;
  new_rank: number;
}

export interface ValueChange<T> {
  ref: string;
  old: T;
  new: T;
}

export interface CaseDiff {
  id: string;
  origin: string;
  level: string;
  type: string;
  added: RefChange[];
  removed: RefChange[];
  reordered: RankChange[];
  score_changes: ValueChange<number>[];
  confidence_changes: ValueChange<string>[];
  /** Added refs that are NOT in the labelled set. */
  new_fp: string[];
  /** Expected refs newly present in top-k (previously missed). */
  fixed_fn: string[];
  /** Expected refs that dropped out of top-k. */
  lost_tp: string[];
}

export interface MetricDelta {
  old: number;
  new: number;
  delta: number;
}

export interface AggregateDelta {
  cases: number;
  precision: MetricDelta;
  recall: MetricDelta;
  mrr: MetricDelta;
  ndcg_at_10: MetricDelta;
  fp: MetricDelta;
  fn: MetricDelta;
}

export interface DiffFile {
  schema: 'search-diff/v1';
  old_engine_hash: string;
  new_engine_hash: string;
  case_count: number;
  changed_case_count: number;
  missing_ids: string[];
  summary: {
    added: number;
    removed: number;
    reordered: number;
    score_changes: number;
    confidence_changes: number;
    new_fp: number;
    fixed_fn: number;
    lost_tp: number;
  };
  aggregate_deltas: {
    overall: AggregateDelta;
    by_origin: Record<string, AggregateDelta>;
    by_level: Record<string, AggregateDelta>;
    by_type: Record<string, AggregateDelta>;
  };
  cases: CaseDiff[];
}

function rankMap(topk: string[]): Map<string, number> {
  const map = new Map<string, number>();
  topk.forEach((ref, index) => map.set(ref, index + 1));
  return map;
}

function resultMap(results: EmitResult[]): Map<string, EmitResult> {
  return new Map(results.map(result => [result.ref, result]));
}

/** Per-case diff of two emit cases with identical ids. */
export function diffCase(oldCase: EmitCase, newCase: EmitCase): CaseDiff {
  const oldRank = rankMap(oldCase.topk);
  const newRank = rankMap(newCase.topk);
  const oldResults = resultMap(oldCase.results);
  const newResults = resultMap(newCase.results);
  const expected = new Set(newCase.expected);

  const added: RefChange[] = [];
  const removed: RefChange[] = [];
  const reordered: RankChange[] = [];
  const scoreChanges: ValueChange<number>[] = [];
  const confidenceChanges: ValueChange<string>[] = [];

  for (const [ref, rank] of newRank) {
    if (!oldRank.has(ref)) {
      added.push({ ref, methods: [...(newResults.get(ref)?.methods ?? [])] });
    } else if (oldRank.get(ref) !== rank) {
      reordered.push({ ref, old_rank: oldRank.get(ref)!, new_rank: rank });
    }
  }
  for (const [ref, rank] of oldRank) {
    if (!newRank.has(ref)) {
      removed.push({ ref, methods: [...(oldResults.get(ref)?.methods ?? [])] });
    }
  }
  for (const [ref] of oldRank) {
    const before = oldResults.get(ref);
    const after = newResults.get(ref);
    if (!before || !after) continue;
    if (before.score !== after.score) {
      scoreChanges.push({ ref, old: before.score, new: after.score });
    }
    if (before.confidence !== after.confidence) {
      confidenceChanges.push({ ref, old: before.confidence, new: after.confidence });
    }
  }

  const newFp = added.filter(change => !expected.has(change.ref)).map(change => change.ref);
  const fixedFn = newCase.expected.filter(ref => newRank.has(ref) && !oldRank.has(ref));
  const lostTp = oldCase.expected.filter(ref => oldRank.has(ref) && !newRank.has(ref));

  const byRef = (a: { ref: string }, b: { ref: string }) =>
    a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  added.sort(byRef);
  removed.sort(byRef);
  reordered.sort(byRef);
  scoreChanges.sort(byRef);
  confidenceChanges.sort(byRef);

  return {
    id: newCase.id,
    origin: newCase.origin,
    level: newCase.level,
    type: newCase.type,
    added,
    removed,
    reordered,
    score_changes: scoreChanges,
    confidence_changes: confidenceChanges,
    new_fp: [...newFp].sort(),
    fixed_fn: [...fixedFn].sort(),
    lost_tp: [...lostTp].sort(),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function delta(oldValues: number[], newValues: number[]): MetricDelta {
  const oldMean = mean(oldValues);
  const newMean = mean(newValues);
  return { old: oldMean, new: newMean, delta: newMean - oldMean };
}

function aggregateDelta(
  oldCases: EmitCase[],
  newCases: EmitCase[],
  keyOf: (evalCase: EmitCase) => string
): AggregateDelta {
  const oldById = new Map(oldCases.map(evalCase => [evalCase.id, evalCase]));
  const newById = new Map(newCases.map(evalCase => [evalCase.id, evalCase]));
  const keys = new Set(
    [...oldById.keys(), ...newById.keys()].map(key => keyOf(oldById.get(key) ?? newById.get(key)!))
  );

  const oldP: number[] = [];
  const newP: number[] = [];
  const oldR: number[] = [];
  const newR: number[] = [];
  const oldMrr: number[] = [];
  const newMrr: number[] = [];
  const oldNdcg: number[] = [];
  const newNdcg: number[] = [];
  let oldFp = 0;
  let newFp = 0;
  let oldFn = 0;
  let newFn = 0;
  let cases = 0;

  for (const key of keys) {
    for (const evalCase of newById.values()) {
      if (keyOf(evalCase) !== key) continue;
      const before = oldById.get(evalCase.id);
      if (!before) continue;
      cases += 1;
      oldP.push(before.precision);
      newP.push(evalCase.precision);
      oldR.push(before.recall);
      newR.push(evalCase.recall);
      oldMrr.push(before.expected.length === 0 ? 0 : before.rr);
      newMrr.push(evalCase.expected.length === 0 ? 0 : evalCase.rr);
      oldNdcg.push(before.expected.length === 0 ? 0 : before.ndcg_at_10);
      newNdcg.push(evalCase.expected.length === 0 ? 0 : evalCase.ndcg_at_10);
      oldFp += before.fp;
      newFp += evalCase.fp;
      oldFn += before.fn;
      newFn += evalCase.fn;
    }
  }

  return {
    cases,
    precision: delta(oldP, newP),
    recall: delta(oldR, newR),
    mrr: delta(oldMrr, newMrr),
    ndcg_at_10: delta(oldNdcg, newNdcg),
    fp: { old: oldFp, new: newFp, delta: newFp - oldFp },
    fn: { old: oldFn, new: newFn, delta: newFn - oldFn },
  };
}

/** Compare two emit files and produce a deterministic diff report. */
export function compareEmits(oldFile: EmitFile, newFile: EmitFile): DiffFile {
  const oldById = new Map(oldFile.cases.map(evalCase => [evalCase.id, evalCase]));
  const newById = new Map(newFile.cases.map(evalCase => [evalCase.id, evalCase]));

  const missingIds = [
    ...oldFile.cases.map(evalCase => evalCase.id).filter(id => !newById.has(id)),
    ...newFile.cases.map(evalCase => evalCase.id).filter(id => !oldById.has(id)),
  ].sort();

  const cases: CaseDiff[] = [];
  for (const evalCase of newFile.cases) {
    const before = oldById.get(evalCase.id);
    if (!before) continue;
    const diff = diffCase(before, evalCase);
    const changed =
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.reordered.length > 0 ||
      diff.score_changes.length > 0 ||
      diff.confidence_changes.length > 0;
    if (changed) cases.push(diff);
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const summary = {
    added: cases.reduce((sum, evalCase) => sum + evalCase.added.length, 0),
    removed: cases.reduce((sum, evalCase) => sum + evalCase.removed.length, 0),
    reordered: cases.reduce((sum, evalCase) => sum + evalCase.reordered.length, 0),
    score_changes: cases.reduce((sum, evalCase) => sum + evalCase.score_changes.length, 0),
    confidence_changes: cases.reduce(
      (sum, evalCase) => sum + evalCase.confidence_changes.length,
      0
    ),
    new_fp: cases.reduce((sum, evalCase) => sum + evalCase.new_fp.length, 0),
    fixed_fn: cases.reduce((sum, evalCase) => sum + evalCase.fixed_fn.length, 0),
    lost_tp: cases.reduce((sum, evalCase) => sum + evalCase.lost_tp.length, 0),
  };

  return {
    schema: 'search-diff/v1',
    old_engine_hash: oldFile.engine_hash,
    new_engine_hash: newFile.engine_hash,
    case_count: newFile.cases.length,
    changed_case_count: cases.length,
    missing_ids: missingIds,
    summary,
    aggregate_deltas: {
      overall: aggregateDelta(oldFile.cases, newFile.cases, () => 'all'),
      by_origin: groupDeltas(oldFile.cases, newFile.cases, evalCase => evalCase.origin),
      by_level: groupDeltas(oldFile.cases, newFile.cases, evalCase => evalCase.level),
      by_type: groupDeltas(oldFile.cases, newFile.cases, evalCase => evalCase.type),
    },
    cases,
  };
}

function groupDeltas(
  oldCases: EmitCase[],
  newCases: EmitCase[],
  keyOf: (evalCase: EmitCase) => string
): Record<string, AggregateDelta> {
  const keys = [...new Set(newCases.map(keyOf))].sort();
  const out: Record<string, AggregateDelta> = {};
  for (const key of keys) {
    out[key] = aggregateDelta(
      oldCases.filter(evalCase => keyOf(evalCase) === key),
      newCases.filter(evalCase => keyOf(evalCase) === key),
      () => key
    );
  }
  return out;
}

// ── CLI ──

interface Args {
  emit: string | null;
  compare: boolean;
  old: string | null;
  new: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { emit: null, compare: false, old: null, new: null, out: null };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--emit') {
      index += 1;
      args.emit = argv[index] ?? null;
    } else if (token === '--compare') {
      args.compare = true;
    } else if (token === '--out') {
      index += 1;
      args.out = argv[index] ?? null;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (args.compare) {
    args.old = positional[0] ?? null;
    args.new = positional[1] ?? null;
  }
  return args;
}

async function main(): Promise<void> {
  const { stableStringify } = await import('../test/search-eval/hash');
  const args = parseArgs(Bun.argv.slice(2));

  if (args.emit) {
    const emit = await buildEmit();
    await Bun.write(args.emit, stableStringify(emit) + '\n');
    console.log(
      `Emitted ${emit.cases.length} cases (engine_hash ${emit.engine_hash.slice(0, 12)}…) to ${args.emit}`
    );
    return;
  }

  if (args.compare) {
    if (!args.old || !args.new) {
      throw new Error('--compare requires <old.json> <new.json>');
    }
    const oldFile = (await Bun.file(args.old).json()) as EmitFile;
    const newFile = (await Bun.file(args.new).json()) as EmitFile;
    const diff = compareEmits(oldFile, newFile);
    const text = stableStringify(diff) + '\n';
    if (args.out) {
      await Bun.write(args.out, text);
      console.log(`Wrote diff ${args.out}`);
    }
    console.log(
      `cases: ${diff.case_count}  changed: ${diff.changed_case_count}  ` +
        `added: ${diff.summary.added}  removed: ${diff.summary.removed}  ` +
        `reordered: ${diff.summary.reordered}  new_fp: ${diff.summary.new_fp}  ` +
        `fixed_fn: ${diff.summary.fixed_fn}  lost_tp: ${diff.summary.lost_tp}`
    );
    return;
  }

  throw new Error(
    'Specify --emit <out.json> or --compare <old.json> <new.json> [--out <diff.json>]'
  );
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
