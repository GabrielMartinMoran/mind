// LoCoMo dataset types and the **dataset-order** category map.
//
// The dataset categorises each QA item with an integer. The mapping below is
// the one used by the dataset's own evaluator (`task_eval/evaluation.py`) and
// by agent-memory-bench — it differs from the order stated in the paper prose,
// so it is hardcoded here and documented once, on purpose. Do not reorder.

export type LocomoCategory = 1 | 2 | 3 | 4 | 5;

/**
 * Category labels in dataset order:
 * `1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial`.
 */
export const CATEGORY_NAMES = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
} as const satisfies Record<LocomoCategory, string>;

export const LOCOMO_CATEGORIES: readonly LocomoCategory[] = [1, 2, 3, 4, 5];

export function isLocomoCategory(value: number): value is LocomoCategory {
  return (LOCOMO_CATEGORIES as readonly number[]).includes(value);
}

export function categoryName(category: number): string {
  return isLocomoCategory(category) ? CATEGORY_NAMES[category] : `unknown:${category}`;
}

/** A single dialogue turn. Image turns may add `img_url` / `blip_caption`. */
export interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string[];
  blip_caption?: string;
  query?: string;
}

/**
 * A QA item. Category-5 (adversarial) items have no `answer`; their expected
 * response lives in `adversarial_answer`. `answer` may also be a number.
 */
export interface LocomoQaItem {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence?: string[];
  category: number;
}

/**
 * A conversation: two speakers plus `session_<n>` turn arrays and
 * `session_<n>_date_time` human-readable timestamps.
 */
export interface LocomoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: unknown;
}

export interface LocomoSample {
  sample_id: string;
  conversation: LocomoConversation;
  qa: LocomoQaItem[];
  [key: string]: unknown;
}

export type LocomoDataset = readonly LocomoSample[];

export function findSample(dataset: LocomoDataset, sampleId: string): LocomoSample | undefined {
  return dataset.find(sample => sample.sample_id === sampleId);
}

/** Session numbers that actually carry a turn array, ascending. */
export function sessionNumbers(conversation: LocomoConversation): number[] {
  const numbers: number[] = [];
  for (const key of Object.keys(conversation)) {
    const match = /^session_(\d+)$/.exec(key);
    if (!match) continue;
    if (!Array.isArray(conversation[key])) continue;
    numbers.push(Number(match[1]));
  }
  return numbers.sort((a, b) => a - b);
}

export function sessionTurns(conversation: LocomoConversation, session: number): LocomoTurn[] {
  const raw = conversation[`session_${session}`];
  return Array.isArray(raw) ? (raw as LocomoTurn[]) : [];
}

export function sessionDateTime(conversation: LocomoConversation, session: number): string {
  const value = conversation[`session_${session}_date_time`];
  return typeof value === 'string' ? value : '';
}

export function conversationTurnCount(conversation: LocomoConversation): number {
  let total = 0;
  for (const session of sessionNumbers(conversation)) {
    total += sessionTurns(conversation, session).length;
  }
  return total;
}
