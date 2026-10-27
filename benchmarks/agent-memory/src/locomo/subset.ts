// Deterministic LoCoMo subset selection.
//
// The subset is seeded so the same dataset + seed always yields the same
// questions (repo precedent: `mulberry32`). For each dataset category, in
// dataset order, candidates are collected in original QA order and a seeded
// Fisher–Yates shuffle picks `perCategory` of them; the picked items are then
// re-sorted by their original question index. Original ids are preserved as
// `<sample_id>#<question index>`, and question text, answer/adversarial answer,
// evidence and category are kept verbatim. No LoCoMo content is stored here.

import {
  LOCOMO_CATEGORIES,
  categoryName,
  findSample,
  type LocomoCategory,
  type LocomoDataset,
  type LocomoQaItem,
  type LocomoSample,
} from './types';

/** Repo-precedent default seed. */
export const DEFAULT_SEED = 20261018;
/** Conversation used by the benchmark (covers all five categories). */
export const DEFAULT_CONVERSATION = 'conv-26';

/** Questions per category: pilot = 1 (5 total), full = 6 (30 total). */
export const SUBSET_SIZES = { pilot: 1, full: 6 } as const;
export type SubsetName = keyof typeof SUBSET_SIZES;

export class SubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubsetError';
  }
}

export interface SubsetItem {
  /** `<sample_id>#<question index>`. */
  readonly id: string;
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: LocomoCategory;
  readonly categoryName: string;
  readonly question: string;
  /** `adversarial_answer` for category 5; `String(answer)` otherwise. */
  readonly answer: string | null;
  readonly evidence: readonly string[];
  readonly adversarial: boolean;
}

export interface SubsetArtifact {
  readonly subset: SubsetName;
  readonly seed: number;
  readonly conversation: string;
  readonly perCategory: number;
  readonly rule: string;
  readonly datasetSha256: string;
  /** Category -> selected count (keys are dataset category numbers). */
  readonly counts: Record<string, number>;
  readonly items: readonly SubsetItem[];
}

/** Seeded PRNG (mulberry32); deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function toSubsetItem(
  sampleId: string,
  questionIndex: number,
  category: LocomoCategory,
  qa: LocomoQaItem
): SubsetItem {
  const adversarial = category === 5;
  const rawAnswer = adversarial ? qa.adversarial_answer : qa.answer;
  const answer =
    rawAnswer === undefined || rawAnswer === null || rawAnswer === '' ? null : String(rawAnswer);
  return {
    id: `${sampleId}#${questionIndex}`,
    sampleId,
    questionIndex,
    category,
    categoryName: categoryName(category),
    question: qa.question,
    answer,
    evidence: qa.evidence ?? [],
    adversarial,
  };
}

export interface SelectSubsetOptions {
  readonly conversation: string;
  readonly perCategory: number;
  readonly seed: number;
}

export function selectSubset(dataset: LocomoDataset, options: SelectSubsetOptions): SubsetItem[] {
  const sample: LocomoSample | undefined = findSample(dataset, options.conversation);
  if (!sample) {
    throw new SubsetError(`conversation '${options.conversation}' not found in dataset`);
  }
  if (options.perCategory <= 0) {
    throw new SubsetError(`perCategory must be positive, got ${options.perCategory}`);
  }

  const rng = mulberry32(options.seed);
  const selected: SubsetItem[] = [];

  for (const category of LOCOMO_CATEGORIES) {
    const candidates = sample.qa
      .map((qa, index) => ({ qa, index }))
      .filter(entry => entry.qa.category === category);
    const picked = shuffle(candidates, rng)
      .slice(0, options.perCategory)
      .sort((a, b) => a.index - b.index);
    for (const { qa, index } of picked) {
      selected.push(toSubsetItem(sample.sample_id, index, category, qa));
    }
  }

  return selected;
}

export interface BuildSubsetOptions {
  readonly subset: SubsetName;
  readonly conversation: string;
  readonly seed: number;
  readonly datasetSha256: string;
}

export function buildSubsetArtifact(
  dataset: LocomoDataset,
  options: BuildSubsetOptions
): SubsetArtifact {
  const perCategory = SUBSET_SIZES[options.subset];
  const items = selectSubset(dataset, {
    conversation: options.conversation,
    perCategory,
    seed: options.seed,
  });

  const counts: Record<string, number> = {};
  for (const category of LOCOMO_CATEGORIES) {
    counts[String(category)] = items.filter(item => item.category === category).length;
  }

  return {
    subset: options.subset,
    seed: options.seed,
    conversation: options.conversation,
    perCategory,
    rule: `${perCategory} question(s) per dataset category (1..5), seeded deterministic selection`,
    datasetSha256: options.datasetSha256,
    counts,
    items,
  };
}
