// Benchmark A2 scoring: a deterministic primary scorer plus a blind LLM judge.
//
// Deterministic (primary): normalized token-F1 against the reference answer for
// categories 1–4, and an abstention/hallucination verdict for category 5
// (adversarial). This is LoCoMo-inspired but NOT identical to the paper (no
// Porter stemming); it is OUR fixed protocol, applied identically to every
// condition.
//
// Blind LLM judge (secondary): one payload per question containing the
// question, the reference and all candidate answers ANONYMIZED and shuffled
// (seeded). The condition→label mapping is kept OUT of the payload and stored
// separately. The judge runs through the same driver with the `judge` profile.

import type { ConditionId } from '../config';
import { mulberry32 } from '../locomo/subset';
import type { DriverTokenUsage, SessionDriver, SessionLimits } from '../opencode/driver';

export type A2Class =
  | 'correct'
  | 'partial'
  | 'incorrect'
  | 'correct_abstention'
  | 'hallucination'
  | 'error';

export const A2_CLASSES: readonly A2Class[] = [
  'correct',
  'partial',
  'incorrect',
  'correct_abstention',
  'hallucination',
  'error',
];

/** The canonical abstention sentence (also used in the A2 prompt template). */
export const ABSTENTION_CANONICAL = 'no information available';
/** Accepted alternative abstention marker (LoCoMo convention). */
export const ABSTENTION_ALT = 'not mentioned';

const ABSTENTION_REGEX =
  /no information available|not mentioned|not enough information|don'?t know|do not know|cannot (?:be )?determin|unable to (?:determine|answer)/i;

/** True when the answer is (or contains) a canonical-ish abstention. */
export function isAbstention(text: string): boolean {
  return ABSTENTION_REGEX.test(text.trim().toLowerCase());
}

const ARTICLES = new Set(['a', 'an', 'the']);

/** Lowercase, strip punctuation, split on non-alphanumerics, drop articles. */
export function normalizeAnswer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0 && !ARTICLES.has(token));
}

function multisetOverlap(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of b) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of a) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }
  return overlap;
}

/** Multiset token-F1 in `[0, 1]`; 0 when either side is empty. */
export function tokenF1(prediction: string, reference: string): number {
  const pred = normalizeAnswer(prediction);
  const ref = normalizeAnswer(reference);
  if (pred.length === 0 || ref.length === 0) return 0;
  const overlap = multisetOverlap(pred, ref);
  if (overlap === 0) return 0;
  const precision = overlap / pred.length;
  const recall = overlap / ref.length;
  return (2 * precision * recall) / (precision + recall);
}

export const F1_CORRECT_THRESHOLD = 0.5;

/** Deterministic class from an F1 value (our fixed protocol). */
export function classifyByF1(f1: number): A2Class {
  if (f1 >= F1_CORRECT_THRESHOLD) return 'correct';
  if (f1 > 0) return 'partial';
  return 'incorrect';
}

export interface DeterministicScore {
  readonly klass: A2Class;
  /** Token-F1 for categories 1–4; `null` for adversarial (cat 5). */
  readonly f1: number | null;
  readonly abstained: boolean;
}

export interface DeterministicInput {
  readonly answer: string;
  readonly reference: string | null;
  readonly adversarial: boolean;
  /** Set when the measurement itself failed (auth/timeout/error). */
  readonly error?: boolean;
}

export function scoreDeterministic(input: DeterministicInput): DeterministicScore {
  const answer = input.answer.trim();
  const abstained = isAbstention(answer);

  if (input.error) return { klass: 'error', f1: null, abstained };
  if (input.adversarial) {
    if (abstained) return { klass: 'correct_abstention', f1: null, abstained: true };
    if (answer.length === 0) return { klass: 'incorrect', f1: null, abstained: false };
    return { klass: 'hallucination', f1: null, abstained: false };
  }
  if (!input.reference) return { klass: 'incorrect', f1: null, abstained };
  const f1 = tokenF1(answer, input.reference);
  return { klass: classifyByF1(f1), f1, abstained };
}

// ── Blind judge payloads ─────────────────────────────────────────────────────

export interface CandidateAnswer {
  readonly condition: ConditionId;
  readonly text: string;
}

export interface QuestionCandidates {
  /** Question id (`conv-26#12`). */
  readonly id: string;
  /** Unique grouping key (`<id>::rep<rep>`); defaults to `id` on legacy fixtures. */
  readonly key?: string;
  readonly rep?: number;
  readonly question: string;
  readonly reference: string | null;
  readonly adversarial: boolean;
  readonly candidates: readonly CandidateAnswer[];
}

export interface BlindPayload {
  readonly id: string;
  readonly prompt: string;
  /** `order[i]` is the condition behind `Candidate ${i + 1}`; never in `prompt`. */
  readonly order: readonly ConditionId[];
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

const JUDGE_RUBRIC = [
  'Score every candidate independently against the reference.',
  'Classes: "correct" (matches the reference), "partial" (partially correct),',
  '"incorrect" (wrong), "correct_abstention" (correctly states the answer is not available),',
  '"hallucination" (invents an answer when none is available).',
].join(' ');

function renderCandidate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.replace(/\s+/g, ' ') : '(no answer)';
}

export function buildBlindPayload(question: QuestionCandidates, rng: () => number): BlindPayload {
  const shuffled = shuffle(question.candidates, rng);
  const order = shuffled.map(candidate => candidate.condition);
  const candidateBlock = shuffled
    .map((candidate, index) => `Candidate ${index + 1}: ${renderCandidate(candidate.text)}`)
    .join('\n');
  const expected = question.adversarial
    ? 'No answer exists; the correct behaviour is a correct abstention.'
    : `Reference answer: ${question.reference ?? '(none)'}`;

  const prompt = [
    'You are a strict, impartial evaluator for a question-answering benchmark.',
    JUDGE_RUBRIC,
    '',
    `Question: ${question.question}`,
    expected,
    '',
    'Candidate answers:',
    candidateBlock,
    '',
    'Reply with ONLY a strict JSON object of the form:',
    '{"verdicts":[{"candidate":1,"class":"correct|partial|incorrect|correct_abstention|hallucination","score":0}],"reason":""}',
    'where "candidate" is the candidate number and "score" is a number in [0,1].',
  ].join('\n');

  return { id: question.key ?? question.id, prompt, order };
}

export function buildBlindPayloads(
  questions: readonly QuestionCandidates[],
  seed: number
): BlindPayload[] {
  const rng = mulberry32(seed);
  return questions.map(question => buildBlindPayload(question, rng));
}

// ── Judge response parsing ───────────────────────────────────────────────────

export interface JudgeVerdict {
  readonly candidate: number;
  readonly klass: string;
  readonly score: number;
}

export interface JudgeResponse {
  readonly verdicts: readonly JudgeVerdict[];
}

/** Strip code fences and parse the first JSON object; tolerant, returns null on failure. */
export function parseJudgeResponse(text: string, expectedCount: number): JudgeResponse | null {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown;
    const verdictsRaw = (parsed as { verdicts?: unknown }).verdicts;
    if (!Array.isArray(verdictsRaw)) return null;
    const verdicts: JudgeVerdict[] = [];
    for (const entry of verdictsRaw) {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const candidate = Number(record.candidate);
      if (!Number.isInteger(candidate) || candidate < 1 || candidate > expectedCount) return null;
      const klass = typeof record.class === 'string' ? record.class : '';
      const rawScore = Number(record.score);
      const score = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
      verdicts.push({ candidate, klass, score });
    }
    return verdicts.length === 0 ? null : { verdicts };
  } catch {
    return null;
  }
}

export function buildJudgeRepairPrompt(payload: BlindPayload): string {
  return [
    'Your previous reply was not valid JSON and could not be parsed.',
    'Repeat the SAME evaluation below and reply with ONLY the strict JSON object.',
    '',
    payload.prompt,
  ].join('\n');
}

export interface JudgeRunOutput {
  /** Question id -> verdicts (candidate numbers map through `payload.order`). */
  readonly verdicts: Record<string, readonly JudgeVerdict[]>;
  /** Question ids whose judge response could not be parsed after one repair. */
  readonly manualQueue: readonly string[];
  readonly costUsd: number;
  readonly promptCount: number;
}

export interface JudgeRunnerDeps {
  readonly driver: SessionDriver;
  readonly workspaceDir: string;
  readonly limits: SessionLimits;
}

/** Run the blind judge for every payload; one repair retry, then manual queue. */
export async function runBlindJudge(
  payloads: readonly BlindPayload[],
  deps: JudgeRunnerDeps
): Promise<JudgeRunOutput> {
  const verdicts: Record<string, readonly JudgeVerdict[]> = {};
  const manualQueue: string[] = [];
  let costUsd = 0;
  let promptCount = 0;

  for (const payload of payloads) {
    const expected = payload.order.length;
    const first = await deps.driver
      .runPrompt({ workspaceDir: deps.workspaceDir, prompt: payload.prompt, limits: deps.limits })
      .catch(() => null);
    promptCount += 1;
    costUsd += first?.costUsd ?? 0;
    const parsed = first ? parseJudgeResponse(first.finalText, expected) : null;
    if (parsed) {
      verdicts[payload.id] = parsed.verdicts;
      continue;
    }

    const repair = await deps.driver
      .runPrompt({
        workspaceDir: deps.workspaceDir,
        prompt: buildJudgeRepairPrompt(payload),
        limits: deps.limits,
      })
      .catch(() => null);
    promptCount += 1;
    costUsd += repair?.costUsd ?? 0;
    const repaired = repair ? parseJudgeResponse(repair.finalText, expected) : null;
    if (repaired) {
      verdicts[payload.id] = repaired.verdicts;
    } else {
      manualQueue.push(payload.id);
    }
  }

  return { verdicts, manualQueue, costUsd, promptCount };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface A2QuestionResult {
  readonly id: string;
  /** Zero-based repetition index; absent on legacy/handcrafted fixtures. */
  readonly rep?: number;
  readonly category: number;
  readonly categoryName: string;
  readonly adversarial: boolean;
  readonly condition: ConditionId;
  readonly answer: string;
  readonly reference: string | null;
  readonly deterministic: DeterministicScore;
  /** Judge verdict for THIS condition's candidate (mapped back from the label). */
  readonly judge: JudgeVerdict | null;
  readonly memoryCalls: number;
  readonly tokens: DriverTokenUsage | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

/** Unique measurement key for a (question, rep) pair. */
export function measurementKey(result: Pick<A2QuestionResult, 'id' | 'rep'>): string {
  return `${result.id}::rep${result.rep ?? 0}`;
}

export interface A2QuestionMean {
  readonly id: string;
  readonly rep: number;
  readonly category: number;
  readonly categoryName: string;
  readonly adversarial: boolean;
  readonly f1: number | null;
  readonly judgeScore: number | null;
  readonly memoryCalls: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/**
 * Project the repeated measurements of one condition into one compact row per
 * (question, rep). This is not a mean: aggregations (means, counts) are derived
 * later from these rows.
 */
export function questionRepRows(results: readonly A2QuestionResult[]): A2QuestionMean[] {
  return results.map(result => ({
    id: result.id,
    rep: result.rep ?? 0,
    category: result.category,
    categoryName: result.categoryName,
    adversarial: result.adversarial,
    f1: result.deterministic.f1,
    judgeScore: result.judge?.score ?? null,
    memoryCalls: result.memoryCalls,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  }));
}

export interface ConditionAggregate {
  readonly condition: ConditionId;
  readonly count: number;
  /** Distinct repetitions observed (0 when no results). */
  readonly reps: number;
  /** Distinct questions observed. */
  readonly questionCount: number;
  readonly classes: Record<A2Class, number>;
  readonly f1Mean: number | null;
  readonly judgeScoreMean: number | null;
  readonly memoryCalls: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly costUsd: number;
  readonly latencyP50Ms: number | null;
}

function emptyClassCounts(): Record<A2Class, number> {
  return {
    correct: 0,
    partial: 0,
    incorrect: 0,
    correct_abstention: 0,
    hallucination: 0,
    error: 0,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile50(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(0.5 * sorted.length));
  return sorted[index] ?? null;
}

export function aggregateCondition(
  condition: ConditionId,
  results: readonly A2QuestionResult[]
): ConditionAggregate {
  const classes = emptyClassCounts();
  for (const result of results) classes[result.deterministic.klass] += 1;
  const reps = new Set(results.map(result => result.rep ?? 0));
  const questions = new Set(results.map(result => result.id));
  return {
    condition,
    count: results.length,
    reps: reps.size,
    questionCount: questions.size,
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
    memoryCalls: results.reduce((sum, result) => sum + result.memoryCalls, 0),
    tokensInput: results.reduce((sum, result) => sum + (result.tokens?.input ?? 0), 0),
    tokensOutput: results.reduce((sum, result) => sum + (result.tokens?.output ?? 0), 0),
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    latencyP50Ms: percentile50(results.map(result => result.latencyMs)),
  };
}

/**
 * Map a judge verdict back to a condition using a payload's `order`. The label
 * `Candidate N` (1-based) is `order[N - 1]`.
 */
export function verdictForCondition(
  verdicts: readonly JudgeVerdict[],
  order: readonly ConditionId[],
  condition: ConditionId
): JudgeVerdict | null {
  const index = order.indexOf(condition);
  if (index === -1) return null;
  return verdicts.find(verdict => verdict.candidate === index + 1) ?? null;
}
