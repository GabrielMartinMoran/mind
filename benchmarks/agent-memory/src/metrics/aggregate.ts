// Benchmark aggregation — turn a run directory into a machine-readable summary.
//
// A run directory contains `meta.json` plus per-stage result files under
// `results/`. Not every stage always ran (the free LoCoMo A1 stage can run on
// its own thread); aggregation therefore tolerates missing artifacts and marks
// them explicitly as `not_run` / `n/a` rather than inventing zeros.
//
// A (LoCoMo retrieval + answering) and B (agent scenarios) metrics are ALWAYS
// kept separate — the report never mixes them into one global percentage — and
// every condition's row carries the exact metrics the plan asked for. The
// `buildSummary` function is pure (no clock, no I/O); `loadRunSummary` is the
// thin I/O wrapper that reads the artifacts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { A2_CLASSES, type A2Class, type A2QuestionResult } from '../benchmarkA/judge';
import type { ScenarioConditionResult, ScenarioRunStatus } from '../benchmarkB/runner';
import { CONDITIONS, type ConditionId } from '../config';
import type { A1Result } from '../locomo/a1';
import { LOCOMO_CATEGORIES, categoryName } from '../locomo/types';
import { readRunMeta, type RunMeta } from '../run';

// ── Small statistics ─────────────────────────────────────────────────────────

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}

function sum(values: readonly (number | null | undefined)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

// ── Summary shapes ───────────────────────────────────────────────────────────

export interface A1BucketSummary {
  readonly count: number;
  readonly evidenceCount: number;
  readonly hitAt5: number | null;
  readonly hitAt10: number | null;
  readonly evidenceRecallAt10: number | null;
  readonly mrr: number | null;
  readonly precisionAt10: number | null;
  readonly contextTokensAt25: number | null;
  readonly latencyP50Ms: number | null;
}

export interface A1Summary {
  /** Categories 1–4 pooled (answerable, non-adversarial). */
  readonly cat1To4: A1BucketSummary;
  /** Category 5 adversarial (evidence is a premise). */
  readonly cat5Adversarial: A1BucketSummary;
  readonly perCategory: Record<string, A1BucketSummary>;
  /** Number of questions scored (one API search each). */
  readonly searchCount: number;
  /** Mean number of ranked results returned per question. */
  readonly resultCountMean: number | null;
}

export interface A2CategorySummary {
  readonly category: number;
  readonly categoryName: string;
  readonly count: number;
  readonly classes: Record<A2Class, number>;
  readonly f1Mean: number | null;
  readonly judgeScoreMean: number | null;
  readonly correctAbstentions: number;
  readonly hallucinations: number;
  readonly memoryCalls: number;
  readonly costUsd: number;
}

export interface A2Summary {
  readonly count: number;
  /** Distinct repetitions pooled into this summary. */
  readonly reps: number;
  readonly classes: Record<A2Class, number>;
  /** Mean deterministic token-F1 over categories 1–4. */
  readonly f1Mean: number | null;
  /** Mean blind-judge score (single number per candidate). */
  readonly judgeScoreMean: number | null;
  /** Category-5 adversarial verdict counts. */
  readonly correctAbstentions: number;
  readonly hallucinations: number;
  readonly memoryCalls: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly costUsd: number;
  readonly latencyP50Ms: number | null;
  /** Dataset-order category breakdown (multi-hop … adversarial). */
  readonly perCategory: Record<string, A2CategorySummary>;
}

export interface BScenarioSummary {
  readonly scenarioId: string;
  readonly title: string;
  readonly pass: boolean;
  /** Explicit execution status; `not_run` must never be read as a failure. */
  readonly status: ScenarioRunStatus;
  readonly notRunReason: string | null;
  readonly details: readonly string[];
  readonly sessionCount: number;
  readonly childCount: number;
  readonly memoryCalls: number;
  readonly costUsd: number;
}

export interface BSummary {
  readonly scenarios: readonly BScenarioSummary[];
  readonly taskSuccess: {
    readonly passed: number;
    readonly failed: number;
    /** Executed scenarios only (`passed + failed`). */
    readonly total: number;
    /** Scenarios skipped because a capability/credential was unavailable. */
    readonly notRun: number;
    /** `passed / total`, or `null` when no scenario was executed. */
    readonly rate: number | null;
  };
  /** Sub-agent (B4) transfer: a child was captured AND the scenario passed. */
  readonly subagent: {
    readonly expected: boolean;
    readonly childCaptured: boolean;
    readonly childCount: number;
    readonly pass: boolean | null;
  };
  readonly memoryCalls: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly costUsd: number;
  readonly latencyP50Ms: number | null;
}

export interface ConditionSummary {
  readonly condition: ConditionId;
  readonly a1: A1Summary | null;
  readonly a2: A2Summary | null;
  readonly b: BSummary | null;
}

export interface ABDiff {
  readonly metric: string;
  readonly v9: number | null;
  readonly v10: number | null;
  /** `v10 - v9` when both are numbers, else `null`. */
  readonly absolute: number | null;
  /** `(v10 - v9) / v9` when `v9` is a non-zero number, else `null`. */
  readonly relative: number | null;
}

export interface TripleMetric {
  readonly metric: string;
  readonly noMemory: number | null;
  readonly mindV9: number | null;
  readonly mindV10: number | null;
}

export interface BaselineDelta {
  readonly condition: ConditionId;
  /** `overall` or a category label. */
  readonly scope: string;
  readonly metric: string;
  readonly baseline: number | null;
  readonly value: number | null;
  /** `value - baseline` when both are numbers, else `null`. */
  readonly absolute: number | null;
  /** `(value - baseline) / baseline` when baseline is a non-zero number, else `null`. */
  readonly relative: number | null;
}

export interface SummaryDiffs {
  readonly a1: readonly ABDiff[];
  readonly a2: readonly ABDiff[];
  readonly b: readonly ABDiff[];
  /** Mind conditions vs the `no-memory` baseline, where meaningful. */
  readonly mindVsNoMemory: readonly TripleMetric[];
  /** Per-condition/per-category deltas against the `no-memory` baseline. */
  readonly a2Baseline: readonly BaselineDelta[];
}

export interface RunSummary {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly conditions: Record<string, ConditionSummary>;
  readonly diffs: SummaryDiffs;
  /** Artifacts/stages that were absent when the summary was built. */
  readonly missingStages: readonly string[];
  /** Human-readable caveats (missing stages, N/A metrics). */
  readonly notes: readonly string[];
}

// ── Per-condition aggregation ────────────────────────────────────────────────

function toBucket(metrics: A1Result['aggregates']['overallCat1To4']): A1BucketSummary {
  return {
    count: metrics.count,
    evidenceCount: metrics.evidenceCount,
    hitAt5: metrics.hitAt5,
    hitAt10: metrics.hitAt10,
    evidenceRecallAt10: metrics.evidenceRecallAt10,
    mrr: metrics.mrr,
    precisionAt10: metrics.precisionAt10,
    contextTokensAt25: metrics.contextTokensAt25,
    latencyP50Ms: metrics.latencyP50Ms,
  };
}

export function aggregateA1(a1: A1Result): A1Summary {
  const perCategory: Record<string, A1BucketSummary> = {};
  for (const [key, metrics] of Object.entries(a1.aggregates.perCategory)) {
    perCategory[key] = toBucket(metrics);
  }
  return {
    cat1To4: toBucket(a1.aggregates.overallCat1To4),
    cat5Adversarial: toBucket(a1.aggregates.cat5Adversarial),
    perCategory,
    searchCount: a1.questions.length,
    resultCountMean: mean(a1.questions.map(question => question.resultCount)),
  };
}

function classCounts(results: readonly A2QuestionResult[]): Record<A2Class, number> {
  const classes = Object.fromEntries(A2_CLASSES.map(name => [name, 0])) as Record<A2Class, number>;
  for (const result of results) classes[result.deterministic.klass] += 1;
  return classes;
}

/** Dataset-order category breakdown of the A2 results. */
export function aggregateA2ByCategory(
  results: readonly A2QuestionResult[]
): Record<string, A2CategorySummary> {
  const out: Record<string, A2CategorySummary> = {};
  for (const category of LOCOMO_CATEGORIES) {
    const group = results.filter(result => result.category === category);
    if (group.length === 0) continue;
    const classes = classCounts(group);
    out[String(category)] = {
      category,
      categoryName: categoryName(category),
      count: group.length,
      classes,
      f1Mean: mean(
        group
          .map(result => result.deterministic.f1)
          .filter((value): value is number => value !== null)
      ),
      judgeScoreMean: mean(
        group
          .map(result => result.judge?.score)
          .filter((value): value is number => typeof value === 'number')
      ),
      correctAbstentions: classes.correct_abstention,
      hallucinations: classes.hallucination,
      memoryCalls: sum(group.map(result => result.memoryCalls)),
      costUsd: sum(group.map(result => result.costUsd)),
    };
  }
  return out;
}

export function aggregateA2(results: readonly A2QuestionResult[]): A2Summary {
  const classes = classCounts(results);
  return {
    count: results.length,
    reps: new Set(results.map(result => result.rep ?? 0)).size,
    classes,
    f1Mean: mean(
      results
        .map(result => result.deterministic.f1)
        .filter((value): value is number => value !== null)
    ),
    judgeScoreMean: mean(
      results
        .map(result => result.judge?.score)
        .filter((value): value is number => typeof value === 'number')
    ),
    correctAbstentions: classes.correct_abstention,
    hallucinations: classes.hallucination,
    memoryCalls: sum(results.map(result => result.memoryCalls)),
    tokensInput: sum(results.map(result => result.tokens?.input)),
    tokensOutput: sum(results.map(result => result.tokens?.output)),
    costUsd: sum(results.map(result => result.costUsd)),
    latencyP50Ms: percentile(
      results.map(result => result.latencyMs),
      50
    ),
    perCategory: aggregateA2ByCategory(results),
  };
}

function allTokens(results: readonly ScenarioConditionResult[]): {
  input: number;
  output: number;
} {
  const usages = results.flatMap(result => [
    ...result.sessions.map(session => session.tokens),
    ...result.childResults.map(child => child.tokens),
  ]);
  return {
    input: sum(usages.map(usage => usage?.input)),
    output: sum(usages.map(usage => usage?.output)),
  };
}

function scenarioStatus(result: ScenarioConditionResult): ScenarioRunStatus {
  if (result.status === 'not_run') return 'not_run';
  return result.assertion.pass ? 'passed' : 'failed';
}

export function aggregateB(results: readonly ScenarioConditionResult[]): BSummary {
  const scenarios: BScenarioSummary[] = results.map(result => {
    const status = scenarioStatus(result);
    return {
      scenarioId: result.scenarioId,
      title: result.title,
      pass: status === 'passed',
      status,
      notRunReason: status === 'not_run' ? (result.notRunReason ?? 'not run') : null,
      details: result.assertion.details,
      sessionCount: result.sessions.length,
      childCount: result.childCount,
      memoryCalls:
        result.memoryCalls +
        result.childResults.reduce((total, child) => total + child.memoryCalls, 0),
      costUsd: result.costUsd,
    };
  });

  const statuses = results.map(scenarioStatus);
  const passed = statuses.filter(status => status === 'passed').length;
  const failed = statuses.filter(status => status === 'failed').length;
  const notRun = statuses.filter(status => status === 'not_run').length;
  const executed = passed + failed;
  const b4 = results.find(result => result.scenarioId === 'b4');
  const b4Status = b4 ? scenarioStatus(b4) : null;
  const tokens = allTokens(results);
  const latencies = results.flatMap(result => result.sessions.map(session => session.latencyMs));

  return {
    scenarios,
    taskSuccess: {
      passed,
      failed,
      total: executed,
      notRun,
      rate: executed === 0 ? null : passed / executed,
    },
    subagent: {
      expected: b4 !== undefined,
      childCaptured: (b4?.childCount ?? 0) > 0,
      childCount: b4?.childCount ?? 0,
      pass: !b4 || b4Status === 'not_run' ? null : b4.childCount > 0 && b4.assertion.pass,
    },
    memoryCalls: scenarios.reduce((total, scenario) => total + scenario.memoryCalls, 0),
    tokensInput: tokens.input,
    tokensOutput: tokens.output,
    costUsd: results.reduce((total, result) => total + result.costUsd, 0),
    latencyP50Ms: percentile(latencies, 50),
  };
}

// ── Diffs ────────────────────────────────────────────────────────────────────

function diff(metric: string, v9: number | null, v10: number | null): ABDiff {
  const absolute = v9 !== null && v10 !== null ? v10 - v9 : null;
  const relative = v9 !== null && v9 !== 0 && v10 !== null ? (v10 - v9) / v9 : null;
  return { metric, v9, v10, absolute, relative };
}

const A1_DIFF_METRICS = [
  ['hitAt5', (s: A1Summary) => s.cat1To4.hitAt5],
  ['hitAt10', (s: A1Summary) => s.cat1To4.hitAt10],
  ['evidenceRecallAt10', (s: A1Summary) => s.cat1To4.evidenceRecallAt10],
  ['mrr', (s: A1Summary) => s.cat1To4.mrr],
  ['precisionAt10', (s: A1Summary) => s.cat1To4.precisionAt10],
  ['contextTokensAt25', (s: A1Summary) => s.cat1To4.contextTokensAt25],
  ['latencyP50Ms', (s: A1Summary) => s.cat1To4.latencyP50Ms],
] as const;

const A2_DIFF_METRICS = [
  ['f1Mean', (s: A2Summary) => s.f1Mean],
  ['judgeScoreMean', (s: A2Summary) => s.judgeScoreMean],
  ['correctAbstentions', (s: A2Summary) => s.correctAbstentions],
  ['hallucinations', (s: A2Summary) => s.hallucinations],
  ['memoryCalls', (s: A2Summary) => s.memoryCalls],
  ['tokensInput', (s: A2Summary) => s.tokensInput],
  ['tokensOutput', (s: A2Summary) => s.tokensOutput],
  ['costUsd', (s: A2Summary) => s.costUsd],
  ['latencyP50Ms', (s: A2Summary) => s.latencyP50Ms],
] as const;

const B_DIFF_METRICS = [
  ['taskSuccessRate', (s: BSummary) => s.taskSuccess.rate],
  ['memoryCalls', (s: BSummary) => s.memoryCalls],
  ['tokensInput', (s: BSummary) => s.tokensInput],
  ['tokensOutput', (s: BSummary) => s.tokensOutput],
  ['costUsd', (s: BSummary) => s.costUsd],
  ['latencyP50Ms', (s: BSummary) => s.latencyP50Ms],
] as const;

function diffSeries<T>(
  metrics: readonly (readonly [string, (summary: T) => number | null])[],
  v9: T | null,
  v10: T | null
): ABDiff[] {
  if (!v9 || !v10) return [];
  return metrics.map(([metric, pick]) => diff(metric, pick(v9), pick(v10)));
}

function buildTriples(conditions: Record<string, ConditionSummary>): TripleMetric[] {
  const noMemoryA2 = conditions['no-memory']?.a2 ?? null;
  const noMemoryB = conditions['no-memory']?.b ?? null;
  const v9A2 = conditions['mind-v9']?.a2 ?? null;
  const v10A2 = conditions['mind-v10']?.a2 ?? null;
  const v9B = conditions['mind-v9']?.b ?? null;
  const v10B = conditions['mind-v10']?.b ?? null;

  const rows: TripleMetric[] = [];
  const add = (
    metric: string,
    noMemory: number | null,
    mindV9: number | null,
    mindV10: number | null
  ) => {
    if (noMemory === null && mindV9 === null && mindV10 === null) return;
    rows.push({ metric, noMemory, mindV9, mindV10 });
  };
  add(
    'a2.judgeScoreMean',
    noMemoryA2?.judgeScoreMean ?? null,
    v9A2?.judgeScoreMean ?? null,
    v10A2?.judgeScoreMean ?? null
  );
  add('a2.f1Mean', noMemoryA2?.f1Mean ?? null, v9A2?.f1Mean ?? null, v10A2?.f1Mean ?? null);
  add(
    'a2.correctAbstentions',
    noMemoryA2?.correctAbstentions ?? null,
    v9A2?.correctAbstentions ?? null,
    v10A2?.correctAbstentions ?? null
  );
  add(
    'a2.memoryCalls',
    noMemoryA2?.memoryCalls ?? null,
    v9A2?.memoryCalls ?? null,
    v10A2?.memoryCalls ?? null
  );
  add(
    'b.taskSuccessRate',
    noMemoryB?.taskSuccess.rate ?? null,
    v9B?.taskSuccess.rate ?? null,
    v10B?.taskSuccess.rate ?? null
  );
  add(
    'b.memoryCalls',
    noMemoryB?.memoryCalls ?? null,
    v9B?.memoryCalls ?? null,
    v10B?.memoryCalls ?? null
  );
  add('b.costUsd', noMemoryB?.costUsd ?? null, v9B?.costUsd ?? null, v10B?.costUsd ?? null);
  return rows;
}

// ── Baseline deltas ──────────────────────────────────────────────────────────

function deltaRow(
  condition: ConditionId,
  scope: string,
  metric: string,
  baseline: number | null,
  value: number | null
): BaselineDelta | null {
  if (baseline === null && value === null) return null;
  const absolute = baseline !== null && value !== null ? value - baseline : null;
  const relative =
    baseline !== null && baseline !== 0 && value !== null ? (value - baseline) / baseline : null;
  return { condition, scope, metric, baseline, value, absolute, relative };
}

const A2_BASELINE_OVERALL = [
  ['judgeScoreMean', (s: A2Summary) => s.judgeScoreMean],
  ['f1Mean', (s: A2Summary) => s.f1Mean],
  ['correctAbstentions', (s: A2Summary) => s.correctAbstentions],
  ['hallucinations', (s: A2Summary) => s.hallucinations],
  ['memoryCalls', (s: A2Summary) => s.memoryCalls],
] as const;

/**
 * Per-condition deltas against the `no-memory` baseline: overall plus one row
 * per dataset category. Absolute always; relative only when the baseline is a
 * non-zero number. `mind-v9`/`mind-v10` rows only appear when their A2 ran.
 */
export function buildA2Baseline(conditions: Record<string, ConditionSummary>): BaselineDelta[] {
  const baseline = conditions['no-memory']?.a2 ?? null;
  const rows: BaselineDelta[] = [];
  for (const condition of ['mind-v9', 'mind-v10'] as const) {
    const value = conditions[condition]?.a2 ?? null;
    if (!value) continue;
    for (const [metric, pick] of A2_BASELINE_OVERALL) {
      const row = deltaRow(
        condition,
        'overall',
        metric,
        baseline ? pick(baseline) : null,
        pick(value)
      );
      if (row) rows.push(row);
    }
    const categories = new Set([
      ...Object.keys(value.perCategory),
      ...Object.keys(baseline?.perCategory ?? {}),
    ]);
    for (const category of [...categories].sort()) {
      const b = baseline?.perCategory[category];
      const v = value.perCategory[category];
      for (const [metric, pick] of [
        ['f1Mean', (s: A2CategorySummary) => s.f1Mean],
        ['judgeScoreMean', (s: A2CategorySummary) => s.judgeScoreMean],
      ] as const) {
        const row = deltaRow(
          condition,
          v?.categoryName ?? b?.categoryName ?? `category ${category}`,
          metric,
          b ? pick(b) : null,
          v ? pick(v) : null
        );
        if (row) rows.push(row);
      }
    }
  }
  return rows;
}

// ── Pure summary builder ─────────────────────────────────────────────────────

export interface AggregateInput {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly a1: Partial<Record<ConditionId, A1Result>>;
  readonly a2: Partial<Record<ConditionId, A2QuestionResult[]>>;
  readonly b: Partial<Record<ConditionId, ScenarioConditionResult[]>>;
  /** Artifact/stage labels known to be absent (e.g. `a1:no-memory`, `a2`). */
  readonly missing: readonly string[];
}

export function buildSummary(input: AggregateInput): RunSummary {
  const conditions: Record<string, ConditionSummary> = {};
  for (const condition of CONDITIONS) {
    const a1 = input.a1[condition];
    const a2 = input.a2[condition];
    const b = input.b[condition];
    conditions[condition] = {
      condition,
      a1: a1 ? aggregateA1(a1) : null,
      a2: a2 ? aggregateA2(a2) : null,
      b: b ? aggregateB(b) : null,
    };
  }

  const v9 = conditions['mind-v9']!;
  const v10 = conditions['mind-v10']!;
  const diffs: SummaryDiffs = {
    a1: diffSeries(A1_DIFF_METRICS, v9.a1, v10.a1),
    a2: diffSeries(A2_DIFF_METRICS, v9.a2, v10.a2),
    b: diffSeries(B_DIFF_METRICS, v9.b, v10.b),
    mindVsNoMemory: buildTriples(conditions),
    a2Baseline: buildA2Baseline(conditions),
  };

  const notes = [...input.missing].map(label => `${label}: not_run`);
  return {
    runId: input.runId,
    meta: input.meta,
    conditions,
    diffs,
    missingStages: input.missing,
    notes,
  };
}

// ── I/O wrapper ──────────────────────────────────────────────────────────────

function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  // A malformed/unreadable artifact is treated as missing so one bad file can
  // never make the whole summary fail to load.
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadRunSummary(runDir: string): RunSummary {
  const meta = readRunMeta(join(runDir, 'meta.json'));
  const a1: Partial<Record<ConditionId, A1Result>> = {};
  const a2: Partial<Record<ConditionId, A2QuestionResult[]>> = {};
  const b: Partial<Record<ConditionId, ScenarioConditionResult[]>> = {};
  const missing: string[] = [];

  for (const condition of CONDITIONS) {
    const a1Result = readJsonIfExists<A1Result>(join(runDir, 'results', `${condition}-a1.json`));
    if (a1Result) a1[condition] = a1Result;

    const a2Result = readJsonIfExists<A2QuestionResult[]>(
      join(runDir, 'results', `a2-${condition}.json`)
    );
    if (a2Result) a2[condition] = a2Result;

    const bResult = readJsonIfExists<ScenarioConditionResult[]>(
      join(runDir, 'results', `scenarios-${condition}.json`)
    );
    if (bResult) b[condition] = bResult;
  }

  if (Object.keys(a1).length === 0) missing.push('a1');
  if (Object.keys(a2).length === 0) missing.push('a2');
  if (Object.keys(b).length === 0) missing.push('b');

  return buildSummary({ runId: meta.runId, meta, a1, a2, b, missing });
}

/** Write `results/summary.json`; returns the written path. */
export function writeRunSummary(runDir: string, summary: RunSummary): string {
  const path = join(runDir, 'results', 'summary.json');
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return path;
}

// ── Human-readable table (in-memory) ─────────────────────────────────────────

function fmt(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

/** Render the comparative A1/A2/B tables as one markdown string. */
export function renderSummaryTable(summary: RunSummary): string {
  const lines: string[] = [];
  const cond = (id: string) => summary.conditions[id];

  lines.push('### A1 retrieval (categories 1–4 pooled)');
  lines.push('');
  lines.push('| condition | hit@5 | hit@10 | recall@10 | MRR | p50 ms | ctx tok@25 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const id of ['mind-v9', 'mind-v10']) {
    const a1 = cond(id)?.a1;
    lines.push(
      `| ${id} | ${fmt(a1?.cat1To4.hitAt5 ?? null)} | ${fmt(a1?.cat1To4.hitAt10 ?? null)} | ` +
        `${fmt(a1?.cat1To4.evidenceRecallAt10 ?? null)} | ${fmt(a1?.cat1To4.mrr ?? null)} | ` +
        `${fmt(a1?.cat1To4.latencyP50Ms ?? null, 1)} | ${fmt(a1?.cat1To4.contextTokensAt25 ?? null, 1)} |`
    );
  }
  // Fraction of cat1–4 questions that carry evidence: the pooled hit/recall/MRR
  // means are computed over the evaluable questions only, so the denominator is
  // disclosed next to the values.
  const evaluable = ['mind-v9', 'mind-v10']
    .map(id => {
      const a1 = cond(id)?.a1;
      if (!a1) return `\`${id}\` n/a`;
      const { count, evidenceCount } = a1.cat1To4;
      const excluded = count - evidenceCount;
      return (
        `\`${id}\` ${evidenceCount}/${count} evaluables` +
        (excluded > 0 ? ` (${excluded} sin evidencia excluida(s))` : '')
      );
    })
    .join('; ');
  lines.push('');
  lines.push(`_Denominador evaluable A1 cat1–4 (excluye preguntas sin evidencia): ${evaluable}._`);
  lines.push('');

  lines.push('### A2 answering');
  lines.push('');
  lines.push(
    '| condition | n | reps | correct | partial | incorrect | abstention | halluc. | F1 mean | judge mean |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const id of ['no-memory', 'mind-v9', 'mind-v10']) {
    const a2 = cond(id)?.a2;
    if (!a2) {
      lines.push(`| ${id} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    lines.push(
      `| ${id} | ${a2.count} | ${a2.reps} | ${a2.classes.correct} | ${a2.classes.partial} | ` +
        `${a2.classes.incorrect} | ${a2.correctAbstentions} | ${a2.hallucinations} | ` +
        `${fmt(a2.f1Mean)} | ${fmt(a2.judgeScoreMean)} |`
    );
  }
  lines.push('');

  lines.push('### B scenarios');
  lines.push('');
  lines.push(
    '| condition | passed/executed | rate | not run | child sessions | memory calls | cost USD |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const id of ['no-memory', 'mind-v9', 'mind-v10']) {
    const b = cond(id)?.b;
    if (!b) {
      lines.push(`| ${id} | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    lines.push(
      `| ${id} | ${b.taskSuccess.passed}/${b.taskSuccess.total} | ${fmt(b.taskSuccess.rate)} | ` +
        `${b.taskSuccess.notRun} | ${b.subagent.childCount} | ${b.memoryCalls} | ${fmt(b.costUsd, 4)} |`
    );
  }

  return lines.join('\n');
}
