// Benchmark A1 — deterministic retrieval over a LoCoMo subset (no LLM).
//
// For each selected question the question TEXT is used verbatim as the search
// query against the condition's space; the top-25 ranked results are captured
// (v10 via `limit=25`, v9 sliced locally). Metrics are computed per question
// and aggregated per dataset category, with category 5 (adversarial) reported
// SEPARATELY because its evidence exists only as a premise for a question whose
// expected answer is adversarial. Questions with no evidence make the
// evidence-based metrics N/A and are recorded as such.

import type { MindEngineAdapter } from '../engines/mind-engine';
import {
  contextTokensAtK,
  evidenceRecallAtK,
  hitAtK,
  mrr,
  precisionAtK,
} from '../metrics/retrieval';

import type { SubsetItem } from './subset';
import { LOCOMO_CATEGORIES } from './types';

export const A1_TOP_K = 25;

export interface A1QuestionMetrics {
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly evidenceRecallAt10: number | null;
  readonly mrr: number | null;
  readonly precisionAt10: number | null;
  readonly contextTokensAt5: number;
  readonly contextTokensAt10: number;
  readonly contextTokensAt25: number;
}

export interface A1QuestionResult {
  readonly id: string;
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly categoryName: string;
  readonly adversarial: boolean;
  readonly question: string;
  readonly answer: string | null;
  readonly evidence: readonly string[];
  /** False for the few dataset questions with no evidence (metrics are N/A). */
  readonly evidenceEvaluable: boolean;
  readonly rankedRefs: readonly string[];
  readonly rankedContents: readonly string[];
  readonly resultCount: number;
  readonly latencyMs: number;
  readonly metrics: A1QuestionMetrics;
}

export interface A1AggregateMetrics {
  /** Number of questions in the bucket. */
  readonly count: number;
  /** Number of questions with evidence (included in the evidence means). */
  readonly evidenceCount: number;
  readonly hitAt5: number | null;
  readonly hitAt10: number | null;
  readonly evidenceRecallAt10: number | null;
  readonly mrr: number | null;
  readonly precisionAt10: number | null;
  readonly contextTokensAt5: number | null;
  readonly contextTokensAt10: number | null;
  readonly contextTokensAt25: number | null;
  readonly latencyP50Ms: number | null;
}

export interface A1Aggregates {
  /** Categories 1–4 pooled (the non-adversarial, answerable questions). */
  readonly overallCat1To4: A1AggregateMetrics;
  /** Category 5 adversarial, reported separately (evidence is a premise). */
  readonly cat5Adversarial: A1AggregateMetrics;
  readonly perCategory: Record<string, A1AggregateMetrics>;
}

export interface A1Result {
  readonly space: string;
  readonly topK: number;
  readonly questions: readonly A1QuestionResult[];
  readonly aggregates: A1Aggregates;
}

export type A1Engine = Pick<MindEngineAdapter, 'space' | 'searchRanked'>;

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

async function evaluateQuestion(
  engine: A1Engine,
  item: SubsetItem,
  space: string
): Promise<A1QuestionResult> {
  const { rows, latencyMs } = await engine.searchRanked(item.question, {
    space,
    limit: A1_TOP_K,
  });
  const rankedRefs = rows.map(row => row.ref);
  const rankedContents = rows.map(row => row.content);
  const evidence = item.evidence;
  const evidenceEvaluable = evidence.length > 0;

  return {
    id: item.id,
    sampleId: item.sampleId,
    questionIndex: item.questionIndex,
    category: item.category,
    categoryName: item.categoryName,
    adversarial: item.adversarial,
    question: item.question,
    answer: item.answer,
    evidence,
    evidenceEvaluable,
    rankedRefs,
    rankedContents,
    resultCount: rows.length,
    latencyMs,
    metrics: {
      hitAt5: evidenceEvaluable && hitAtK(rankedRefs, evidence, 5),
      hitAt10: evidenceEvaluable && hitAtK(rankedRefs, evidence, 10),
      evidenceRecallAt10: evidenceRecallAtK(rankedRefs, evidence, 10),
      mrr: mrr(rankedRefs, evidence, A1_TOP_K),
      precisionAt10: precisionAtK(rankedRefs, evidence, 10),
      contextTokensAt5: contextTokensAtK(rankedContents, 5),
      contextTokensAt10: contextTokensAtK(rankedContents, 10),
      contextTokensAt25: contextTokensAtK(rankedContents, A1_TOP_K),
    },
  };
}

function aggregate(results: readonly A1QuestionResult[]): A1AggregateMetrics {
  const evaluable = results.filter(result => result.evidenceEvaluable);
  const hitRate = (pick: (result: A1QuestionResult) => boolean): number | null =>
    mean(evaluable.map(result => (pick(result) ? 1 : 0)));
  return {
    count: results.length,
    evidenceCount: evaluable.length,
    hitAt5: hitRate(result => result.metrics.hitAt5),
    hitAt10: hitRate(result => result.metrics.hitAt10),
    evidenceRecallAt10: mean(
      evaluable
        .map(result => result.metrics.evidenceRecallAt10)
        .filter((value): value is number => value !== null)
    ),
    mrr: mean(
      evaluable.map(result => result.metrics.mrr).filter((value): value is number => value !== null)
    ),
    precisionAt10: mean(
      evaluable
        .map(result => result.metrics.precisionAt10)
        .filter((value): value is number => value !== null)
    ),
    contextTokensAt5: mean(results.map(result => result.metrics.contextTokensAt5)),
    contextTokensAt10: mean(results.map(result => result.metrics.contextTokensAt10)),
    contextTokensAt25: mean(results.map(result => result.metrics.contextTokensAt25)),
    latencyP50Ms: percentile(
      results.map(result => result.latencyMs),
      50
    ),
  };
}

function aggregateSubset(results: readonly A1QuestionResult[]): A1Aggregates {
  const cat1To4 = results.filter(result => result.category !== 5);
  const cat5 = results.filter(result => result.category === 5);
  const perCategory: Record<string, A1AggregateMetrics> = {};
  for (const category of LOCOMO_CATEGORIES) {
    perCategory[String(category)] = aggregate(results.filter(r => r.category === category));
  }
  return {
    overallCat1To4: aggregate(cat1To4),
    cat5Adversarial: aggregate(cat5),
    perCategory,
  };
}

export interface RunA1Options {
  readonly space?: string;
}

export async function runA1(
  engine: A1Engine,
  subset: readonly SubsetItem[],
  options: RunA1Options = {}
): Promise<A1Result> {
  const space = options.space ?? engine.space;
  const questions: A1QuestionResult[] = [];
  for (const item of subset) {
    questions.push(await evaluateQuestion(engine, item, space));
  }
  return {
    space,
    topK: A1_TOP_K,
    questions,
    aggregates: aggregateSubset(questions),
  };
}
