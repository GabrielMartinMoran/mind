// Experiment B — representation transforms and evidence matching.
//
// Pure, deterministic helpers only: no I/O, no clock, no LLM. Given the same
// LoCoMo conversation turns they produce the memory drafts for each
// representation and define how a retrieved memory is mapped back to the
// dataset `dia_id` evidence list.
//
// Representations:
//   V1  one memory per turn, current benchmark ingestion (name = dia_id).
//   V2  one memory per turn, descriptive name + enriched provenance tags;
//       content byte-identical to V1.
//   V2n name-only sub-variant: descriptive names, original tags.
//   V3  one memory per session, turns in order inside the content.

import type { TurnRecord } from '../../src/locomo/ingest';

export type RepresentationId = 'V1' | 'V2' | 'V2n' | 'V3';
export type TurnRepresentationId = Exclude<RepresentationId, 'V3'>;

export const REPRESENTATIONS: readonly {
  readonly id: RepresentationId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: 'V1',
    label: 'turn (current)',
    description:
      'One memory per turn; name = dia_id; content = [date] speaker: text; tags [locomo, session:n].',
  },
  {
    id: 'V2',
    label: 'turn + descriptive metadata',
    description:
      'Same content as V1; descriptive deterministic name with session/dia/speaker/other participant/turn; tags add speaker and dia provenance.',
  },
  {
    id: 'V2n',
    label: 'turn + descriptive name only',
    description:
      'V2 descriptive names with the original V1 tags (separates the name effect from the tag effect).',
  },
  {
    id: 'V3',
    label: 'session group',
    description:
      'One memory per session; content = date header + every turn prefixed [dia_id] speaker: text (+ photo caption); tags [locomo, session:n].',
  },
];

export interface MemoryDraft {
  readonly name: string;
  readonly content: string;
  readonly tags: readonly string[];
}

/** Lowercase, replace every non-alphanumeric run with one dash, trim dashes. */
export function slugToken(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/** The other participant of a two-party conversation, or undefined. */
export function otherSpeaker(
  turn: TurnRecord,
  participants: readonly string[]
): string | undefined {
  const distinct = participants.filter(
    (name, index) =>
      name.length > 0 &&
      participants.findIndex(candidate => candidate.toLowerCase() === name.toLowerCase()) === index
  );
  const other = distinct.find(name => name.toLowerCase() !== turn.speaker.toLowerCase());
  return other;
}

/**
 * Deterministic descriptive name for a turn.
 *
 * Format: `s<session>-d<diaSession>-<speaker>[-<otherSpeaker>]-<turn>`, all
 * lowercase slugs. Example: `D17:10` spoken by Melanie to Caroline in session
 * 17 → `s17-d17-melanie-caroline-10`. Every token comes from the ingested data
 * (session number, dia_id, speaker, the other participant when determinable);
 * no topic, sentiment or relation is invented.
 */
export function descriptiveName(turn: TurnRecord, other?: string): string {
  const [diaSession = '', ...turnParts] = turn.diaId.split(':');
  const parts = [`s${turn.session}`, slugToken(diaSession), slugToken(turn.speaker)];
  if (other) parts.push(slugToken(other));
  parts.push(slugToken(turnParts.join('-') || '0'));
  return parts.join('-');
}

/** V1/V2/V2n memory drafts, one per turn, in conversation order. */
export function buildTurnMemories(
  turns: readonly TurnRecord[],
  id: TurnRepresentationId,
  participants: readonly string[]
): MemoryDraft[] {
  return turns.map(turn => {
    const other = otherSpeaker(turn, participants);
    const name = id === 'V1' ? turn.diaId : descriptiveName(turn, other);
    const tags =
      id === 'V2'
        ? [
            'locomo',
            `session:${turn.session}`,
            `speaker:${slugToken(turn.speaker)}`,
            `dia:${turn.diaId.toLowerCase()}`,
          ]
        : ['locomo', `session:${turn.session}`];
    return { name, content: turn.content, tags };
  });
}

export interface SessionDraft extends MemoryDraft {
  readonly session: number;
  readonly diaIds: readonly string[];
}

/** One memory per session: date header, then every turn in order. */
export function buildSessionMemories(turns: readonly TurnRecord[]): SessionDraft[] {
  const bySession = new Map<number, TurnRecord[]>();
  for (const turn of turns) {
    const list = bySession.get(turn.session) ?? [];
    list.push(turn);
    bySession.set(turn.session, list);
  }
  return [...bySession.entries()]
    .sort(([a], [b]) => a - b)
    .map(([session, sessionTurns]) => {
      const dateTime = sessionTurns[0]?.sessionDateTime ?? '';
      const lines = [`[${dateTime}]`, ...sessionTurns.map(turnLine)];
      return {
        name: `session-${session}`,
        content: lines.join('\n'),
        tags: ['locomo', `session:${session}`],
        session,
        diaIds: sessionTurns.map(turn => turn.diaId),
      };
    });
}

function turnLine(turn: TurnRecord): string {
  const head = `[${turn.diaId}] ${turn.speaker}: ${turn.text}`;
  return turn.blipCaption ? `${head}\n[Photo: ${turn.blipCaption}]` : head;
}

// ── Evidence matching ──

export type EvidenceMatcher =
  | { readonly kind: 'dia-name' }
  | { readonly kind: 'dia-tag' }
  | { readonly kind: 'registry'; readonly nameToDia: ReadonlyMap<string, string> }
  | { readonly kind: 'containment' };

export interface RetrievedMemory {
  readonly name: string;
  readonly content: string;
  readonly tags: readonly string[];
}

export function normalizeDia(value: string): string {
  return value.trim().toLowerCase();
}

/** The `dia:<dia_id>` provenance tag, normalized, or undefined. */
export function diaFromTags(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    if (tag.toLowerCase().startsWith('dia:')) return normalizeDia(tag.slice(4));
  }
  return undefined;
}

/** All `[Dx:y]` ids present in a session-grouped memory content. */
export function diaIdsInContent(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(/\[([A-Za-z]+\d*:\d+)\]/g)) {
    const id = match[1];
    if (id) ids.add(normalizeDia(id));
  }
  return ids;
}

/** Evidence ids that a single retrieved memory can satisfy. */
export function evidenceIdsFor(memory: RetrievedMemory, matcher: EvidenceMatcher): Set<string> {
  switch (matcher.kind) {
    case 'dia-name':
      return new Set([normalizeDia(memory.name)]);
    case 'dia-tag': {
      const dia = diaFromTags(memory.tags);
      return dia ? new Set([dia]) : new Set();
    }
    case 'registry': {
      const dia = matcher.nameToDia.get(memory.name);
      return dia ? new Set([normalizeDia(dia)]) : new Set();
    }
    case 'containment':
      return diaIdsInContent(memory.content);
  }
}

export interface EvidenceMatch {
  /** First 0-based rank at which each gold evidence item appears. */
  readonly ranks: ReadonlyMap<string, number>;
  /** Number of gold items with any match (unbounded by rank). */
  readonly matched: number;
  /** Number of returned memories that satisfy at least one gold item. */
  readonly relevantMemories: number;
}

/** Map ranked memories to gold evidence with first-rank and memory-purity data. */
export function matchEvidence(
  ranked: readonly RetrievedMemory[],
  gold: readonly string[],
  matcher: EvidenceMatcher
): EvidenceMatch {
  const goldSet = new Set(gold.map(normalizeDia));
  const ranks = new Map<string, number>();
  let relevantMemories = 0;
  ranked.forEach((memory, index) => {
    const ids = evidenceIdsFor(memory, matcher);
    let relevant = false;
    for (const id of ids) {
      if (!goldSet.has(id)) continue;
      relevant = true;
      if (!ranks.has(id)) ranks.set(id, index);
    }
    if (relevant) relevantMemories += 1;
  });
  return { ranks, matched: ranks.size, relevantMemories };
}

export interface ProbeEvaluation {
  readonly goldCount: number;
  readonly matched: number;
  /** Gold items inside the top-`k` window. */
  readonly matchedWithinK: number;
  readonly firstRank: number | null;
  readonly hitAny: boolean;
  readonly fullEvidence: boolean;
  readonly evidenceRecall: number | null;
  readonly reciprocalRank: number | null;
  readonly precision: number | null;
  readonly contextTokens: number;
  readonly resultCount: number;
}

/** Evaluate one ranked list at `k` (and MRR depth `max(25, k)`). */
export function evaluateProbe(
  ranked: readonly RetrievedMemory[],
  gold: readonly string[],
  matcher: EvidenceMatcher,
  k: number
): ProbeEvaluation {
  const match = matchEvidence(ranked, gold, matcher);
  const considered = ranked.slice(0, Math.max(0, k));
  const resultCount = ranked.length;
  if (gold.length === 0) {
    return {
      goldCount: 0,
      matched: 0,
      matchedWithinK: 0,
      firstRank: null,
      hitAny: false,
      fullEvidence: false,
      evidenceRecall: null,
      reciprocalRank: null,
      precision: null,
      contextTokens: sumTokens(considered),
      resultCount,
    };
  }
  const rankedGold = [...match.ranks.values()].sort((a, b) => a - b);
  const firstRank = rankedGold[0] ?? null;
  const within = (rank: number, depth: number): boolean => rank < depth;
  const matchedWithin = rankedGold.filter(rank => within(rank, k)).length;
  const hitAny = matchedWithin > 0;
  const fullEvidence = matchedWithin === gold.length;
  const mrrDepth = Math.max(25, k);
  const reciprocalRank = firstRank !== null && firstRank < mrrDepth ? 1 / (firstRank + 1) : 0;
  return {
    goldCount: gold.length,
    matched: match.matched,
    matchedWithinK: matchedWithin,
    firstRank,
    hitAny,
    fullEvidence,
    evidenceRecall: matchedWithin / gold.length,
    reciprocalRank,
    precision: considered.length === 0 ? 0 : match.relevantMemories / considered.length,
    contextTokens: sumTokens(considered),
    resultCount,
  };
}

function sumTokens(memories: readonly RetrievedMemory[]): number {
  let total = 0;
  for (const memory of memories) total += estimateTokens(memory.content);
  return total;
}

/** `ceil(chars / 4)`, the same documented heuristic as the A1 metrics. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MetricsSummary {
  readonly probes: number;
  readonly evidence_count: number;
  readonly hit_at_k: number | null;
  readonly full_evidence_at_k: number | null;
  readonly evidence_recall_at_k: number | null;
  readonly mrr: number | null;
  readonly precision_at_k: number | null;
  readonly context_tokens_at_k: number | null;
  readonly mean_results: number;
  readonly zero_result_count: number;
  readonly latency_p50_ms: number;
}

export interface EvaluatedProbe {
  readonly evaluation: ProbeEvaluation;
  readonly latencyMs: number;
}

/** Aggregate per-probe evaluations; probes without gold are excluded from evidence metrics. */
export function summarizeMetrics(probes: readonly EvaluatedProbe[], _k: number): MetricsSummary {
  const withGold = probes.filter(probe => probe.evaluation.goldCount > 0);
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  return {
    probes: probes.length,
    evidence_count: withGold.length,
    hit_at_k: mean(withGold.map(probe => (probe.evaluation.hitAny ? 1 : 0))),
    full_evidence_at_k: mean(withGold.map(probe => (probe.evaluation.fullEvidence ? 1 : 0))),
    evidence_recall_at_k: mean(
      withGold
        .map(probe => probe.evaluation.evidenceRecall)
        .filter((value): value is number => value !== null)
    ),
    mrr: mean(
      withGold
        .map(probe => probe.evaluation.reciprocalRank)
        .filter((value): value is number => value !== null)
    ),
    precision_at_k: mean(
      withGold
        .map(probe => probe.evaluation.precision)
        .filter((value): value is number => value !== null)
    ),
    context_tokens_at_k: mean(probes.map(probe => probe.evaluation.contextTokens)),
    mean_results: mean(probes.map(probe => probe.evaluation.resultCount)) ?? 0,
    zero_result_count: probes.filter(probe => probe.evaluation.resultCount === 0).length,
    latency_p50_ms: percentile(
      probes.map(probe => probe.latencyMs),
      50
    ),
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

// ── V1 sanity gate ──

export interface FunnelCounts {
  readonly ALL: number;
  readonly partial: number;
  readonly NONE: number;
  readonly no_evidence_gold: number;
}

/** Answerable-probe funnel at K=10. */
export function summarizeFunnel(evaluations: readonly ProbeEvaluation[]): FunnelCounts {
  const funnel = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
  for (const evaluation of evaluations) {
    if (evaluation.goldCount === 0) {
      funnel.no_evidence_gold += 1;
      continue;
    }
    if (evaluation.matchedWithinK === 0) funnel.NONE += 1;
    else if (evaluation.fullEvidence) funnel.ALL += 1;
    else funnel.partial += 1;
  }
  return funnel;
}

export interface ItemLabelCounts {
  readonly total: number;
  readonly admitted_top10: number;
  readonly admitted_outside_top10: number;
  readonly absent_from_ranking: number;
}

/**
 * Count evidence items by where they land in a full ranked list. The frozen
 * classification additionally splits `absent_from_ranking` into
 * `dropped_by_admission` vs `never_candidate` using instrumented channel dumps;
 * that split cannot be observed from the public search response.
 */
export function summarizeItemLabels(
  rankings: readonly (readonly string[])[],
  golds: readonly (readonly string[])[]
): ItemLabelCounts {
  let total = 0;
  let top = 0;
  let outside = 0;
  let absent = 0;
  rankings.forEach((ranking, index) => {
    const ranked = new Set(ranking.map(normalizeDia));
    for (const item of golds[index] ?? []) {
      total += 1;
      const id = normalizeDia(item);
      if (!ranked.has(id)) {
        absent += 1;
        continue;
      }
      const rank = ranking.findIndex(candidate => normalizeDia(candidate) === id);
      if (rank >= 0 && rank < 10) top += 1;
      else outside += 1;
    }
  });
  return {
    total,
    admitted_top10: top,
    admitted_outside_top10: outside,
    absent_from_ranking: absent,
  };
}

/** Compare two per-probe top-10 name lists. */
export function compareTop10(
  actual: readonly (readonly string[])[],
  expected: readonly (readonly string[])[]
): { readonly compared: number; readonly mismatches: number } {
  const compared = Math.min(actual.length, expected.length);
  let mismatches = actual.length === expected.length ? 0 : 1;
  for (let index = 0; index < compared; index += 1) {
    const left = JSON.stringify(actual[index]?.slice(0, 10) ?? []);
    const right = JSON.stringify(expected[index]?.slice(0, 10) ?? []);
    if (left !== right) mismatches += 1;
  }
  return { compared, mismatches };
}

// ── Effect separation ──

export interface MetricDelta {
  readonly hit_at_k_pp: number | null;
  readonly full_evidence_at_k_pp: number | null;
  readonly evidence_recall_at_k_pp: number | null;
  readonly mrr_delta: number | null;
  readonly precision_at_k_pp: number | null;
  readonly context_tokens_delta: number | null;
  readonly mean_results_delta: number | null;
}

const ppDelta = (value: number | null, base: number | null): number | null =>
  value === null || base === null ? null : (value - base) * 100;

const absDelta = (value: number | null, base: number | null): number | null =>
  value === null || base === null ? null : value - base;

export function metricDelta(variant: MetricsSummary, base: MetricsSummary): MetricDelta {
  return {
    hit_at_k_pp: ppDelta(variant.hit_at_k, base.hit_at_k),
    full_evidence_at_k_pp: ppDelta(variant.full_evidence_at_k, base.full_evidence_at_k),
    evidence_recall_at_k_pp: ppDelta(variant.evidence_recall_at_k, base.evidence_recall_at_k),
    mrr_delta: absDelta(variant.mrr, base.mrr),
    precision_at_k_pp: ppDelta(variant.precision_at_k, base.precision_at_k),
    context_tokens_delta: absDelta(variant.context_tokens_at_k, base.context_tokens_at_k),
    mean_results_delta: absDelta(variant.mean_results, base.mean_results),
  };
}
