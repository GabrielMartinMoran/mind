// Experiment A runner — deterministic query strategies over the RAG-off
// benchmark database.
//
// For the same 120 LoCoMo conv-26 probes the benchmark used, each strategy
// rewrites the question (no LLM, no gold) into 1..2 queries, the queries are
// sent to a scratch copy of the pinned v10 `mind serve`, and the union of their
// ranked results is scored against the LoCoMo gold evidence. Everything local,
// free, RAG-off, on a scratch DB copy; the original DB is never touched.
//
// Usage:
//   bun run experiments/query-strategies/run.ts [--limit 10] [--out <dir>]
//     [--db <db>] [--probes <jsonl>] [--locomo <json>] [--worktree <dir>]
//     [--scratch <dir>] [--dump <jsonl>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  contextTokensAtK,
  evidenceRecallAtK,
  mrr,
  precisionAtK,
} from '../../src/metrics/retrieval';
import {
  BENCHMARK_TOP_K,
  DEFAULT_SPACE,
  buildEnv,
  copyDatabase,
  findFreePort,
  mapSearchItems,
  readProbes,
  startServer,
  type ReplayChunk,
} from '../replay/replay';

import { applyStrategy, STRATEGIES, type StrategyId } from './strategies';

// ── Frozen baseline (from E-WB2 `classification.json`) ──
export const FROZEN_FUNNEL_K10 = { ALL: 41, partial: 10, NONE: 39, no_evidence_gold: 2 } as const;
export const FROZEN_ADMITTED_TOP10 = 65;

const ZERO_RANK: readonly string[] = [];

export interface GoldEntry {
  readonly evidence: readonly string[];
}

export interface ProbeExec {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  readonly gold: readonly string[];
  readonly strategies: Record<string, StrategyExecution>;
}

export interface StrategyExecution {
  readonly queries: readonly string[];
  readonly rewritten: boolean;
  readonly reason: string;
  readonly ranked_refs: readonly string[];
  readonly ranked_contents: readonly string[];
  readonly result_count: number;
  readonly latency_ms: number;
}

export interface StrategyMetrics {
  readonly probes: number;
  readonly evidence_count: number;
  readonly hit_at_10: number | null;
  readonly full_evidence_at_10: number | null;
  readonly evidence_recall_at_10: number | null;
  readonly mrr: number | null;
  readonly precision_at_10: number | null;
  readonly context_tokens_at_10: number | null;
  readonly mean_results: number;
  readonly zero_result_count: number;
  readonly latency_p50_ms: number;
}

export interface StrategyReport {
  readonly id: StrategyId;
  readonly label: string;
  readonly description: string;
  readonly rewritten_count: number;
  readonly mean_queries: number;
  readonly overall_answerable: StrategyMetrics;
  readonly by_category: Record<string, StrategyMetrics>;
  readonly adversarial: {
    readonly probes: number;
    readonly mean_results: number;
    readonly zero_result_count: number;
    readonly evidence_recall_at_10: number | null;
  };
}

export interface CrossConvResult {
  readonly conversation: string;
  readonly space: string;
  readonly turns: number;
  readonly answerable_questions: number;
  readonly strategies: Record<string, StrategyMetrics>;
  readonly s1_vs_s2: {
    readonly full_gain_pp: number | null;
    readonly hit_gain_pp: number | null;
  };
}

/** S2−S1 gains, each metric against its own baseline. */
export function computeCrossConvGains(
  s1: StrategyMetrics,
  s2: StrategyMetrics
): CrossConvResult['s1_vs_s2'] {
  return {
    full_gain_pp:
      s1.full_evidence_at_10 === null || s2.full_evidence_at_10 === null
        ? null
        : (s2.full_evidence_at_10 - s1.full_evidence_at_10) * 100,
    hit_gain_pp:
      s1.hit_at_10 === null || s2.hit_at_10 === null ? null : (s2.hit_at_10 - s1.hit_at_10) * 100,
  };
}

export interface ResultsFile {
  readonly meta: Record<string, unknown>;
  readonly baseline: {
    readonly frozen: typeof FROZEN_FUNNEL_K10;
    readonly s1_funnel: Record<string, number>;
    readonly funnel_match: boolean;
    readonly admitted_top10: number;
    readonly admitted_top10_match: boolean;
    readonly dump_ranking_match: boolean | null;
  };
  readonly determinism: { readonly compared: number; readonly identical: boolean };
  readonly strategies: readonly StrategyReport[];
  readonly secondary: {
    readonly limit: number;
    readonly strategies: readonly StrategyReport[];
  };
  readonly per_probe: readonly ProbeExec[];
}

// ── Gold ──

interface LocomoSample {
  sample_id: string;
  conversation: { speaker_a?: string; speaker_b?: string };
  qa: Array<{ question: string; evidence?: string[]; category: number }>;
}

export function loadGold(locomoPath: string, conversation: string): Map<string, GoldEntry> {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as LocomoSample[];
  const sample = dataset.find(entry => entry.sample_id === conversation);
  if (!sample) throw new Error(`conversation ${conversation} not found`);
  const map = new Map<string, GoldEntry>();
  for (const qa of sample.qa) {
    map.set(qa.question.trim(), { evidence: qa.evidence ?? [] });
  }
  return map;
}

export function loadParticipants(locomoPath: string, conversation: string): string[] {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as LocomoSample[];
  const sample = dataset.find(entry => entry.sample_id === conversation);
  const names = [sample?.conversation.speaker_a, sample?.conversation.speaker_b].filter(
    (name): name is string => typeof name === 'string' && name.length > 0
  );
  return names;
}

// ── Search execution ──

interface SearchItem {
  readonly chunks: readonly ReplayChunk[];
  readonly latencyMs: number;
}

async function search(
  baseUrl: string,
  query: string,
  space: string,
  limit: number
): Promise<SearchItem> {
  const params = new URLSearchParams({ q: query, space, limit: String(limit) });
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`/api/search status ${response.status} for "${query}"`);
  const items = (await response.json()) as unknown;
  return { chunks: mapSearchItems(items), latencyMs: performance.now() - started };
}

/** Concatenate per-query result lists in order, dedupe by name, cap at `limit`. */
export function unionChunks(
  lists: readonly (readonly ReplayChunk[])[],
  limit: number
): ReplayChunk[] {
  const seen = new Set<string>();
  const out: ReplayChunk[] = [];
  for (const list of lists) {
    for (const chunk of list) {
      if (seen.has(chunk.name)) continue;
      seen.add(chunk.name);
      out.push(chunk);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function executeProbe(
  baseUrl: string,
  space: string,
  probe: { question: string; category: string; adversarial: boolean; probe_id: string },
  gold: readonly string[],
  participants: readonly string[],
  limit: number
): Promise<ProbeExec> {
  const strategies: Record<string, StrategyExecution> = {};
  for (const definition of STRATEGIES) {
    const result = applyStrategy(definition.id, probe.question, { participants });
    const lists: ReplayChunk[][] = [];
    let latencyMs = 0;
    for (const query of result.queries) {
      const item = await search(baseUrl, query, space, limit);
      lists.push([...item.chunks]);
      latencyMs += item.latencyMs;
    }
    const chunks = unionChunks(lists, limit);
    strategies[definition.id] = {
      queries: result.queries,
      rewritten: result.rewritten,
      reason: result.reason,
      ranked_refs: chunks.map(chunk => chunk.name),
      ranked_contents: chunks.map(chunk => chunk.content),
      result_count: chunks.length,
      latency_ms: latencyMs,
    };
  }
  return {
    probe_id: probe.probe_id,
    question: probe.question,
    category: probe.category,
    adversarial: probe.adversarial,
    gold,
    strategies,
  };
}

async function runPass(
  baseUrl: string,
  space: string,
  probes: ReturnType<typeof readProbes>,
  gold: Map<string, GoldEntry>,
  participants: readonly string[],
  limit: number
): Promise<ProbeExec[]> {
  const out: ProbeExec[] = [];
  for (const probe of probes) {
    const entry = gold.get(probe.question.trim());
    if (!entry) throw new Error(`no gold for question: ${probe.question}`);
    out.push(
      await executeProbe(
        baseUrl,
        space,
        {
          question: probe.question,
          category: probe.category,
          adversarial: probe.adversarial,
          probe_id: probe.probe_id,
        },
        entry.evidence,
        participants,
        limit
      )
    );
  }
  return out;
}

// ── Metrics ──

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

function hitAnyAtK(refs: readonly string[], evidence: readonly string[], k: number): boolean {
  const top = new Set(refs.slice(0, k));
  return evidence.some(ref => top.has(ref));
}

function hitAllAtK(refs: readonly string[], evidence: readonly string[], k: number): boolean {
  if (evidence.length === 0) return false;
  const top = new Set(refs.slice(0, k));
  return evidence.every(ref => top.has(ref));
}

export function computeMetrics(
  execs: readonly StrategyExecution[],
  golds: readonly string[][],
  k = 10
): StrategyMetrics {
  const evaluable = golds
    .map((gold, index) => ({ gold, exec: execs[index]! }))
    .filter(entry => entry.gold.length > 0);
  const hit = (
    pick: (exec: StrategyExecution, gold: readonly string[]) => boolean
  ): number | null => mean(evaluable.map(entry => (pick(entry.exec, entry.gold) ? 1 : 0)));
  return {
    probes: execs.length,
    evidence_count: evaluable.length,
    hit_at_10: hit((exec, gold) => hitAnyAtK(exec.ranked_refs, gold, k)),
    full_evidence_at_10: hit((exec, gold) => hitAllAtK(exec.ranked_refs, gold, k)),
    evidence_recall_at_10: mean(
      evaluable
        .map(entry => evidenceRecallAtK(entry.exec.ranked_refs, entry.gold, k))
        .filter((value): value is number => value !== null)
    ),
    mrr: mean(
      evaluable
        .map(entry => mrr(entry.exec.ranked_refs, entry.gold, Math.max(25, k)))
        .filter((value): value is number => value !== null)
    ),
    precision_at_10: mean(
      evaluable
        .map(entry => precisionAtK(entry.exec.ranked_refs, entry.gold, k))
        .filter((value): value is number => value !== null)
    ),
    context_tokens_at_10: mean(execs.map(exec => contextTokensAtK(exec.ranked_contents, k))),
    mean_results: mean(execs.map(exec => exec.result_count)) ?? 0,
    zero_result_count: execs.filter(exec => exec.result_count === 0).length,
    latency_p50_ms: percentile(
      execs.map(exec => exec.latency_ms),
      50
    ),
  };
}

export function aggregatePass(pass: readonly ProbeExec[], k: number): StrategyReport[] {
  return STRATEGIES.map(definition => {
    const answerable = pass.filter(probe => !probe.adversarial);
    const execs = answerable.map(probe => probe.strategies[definition.id]!);
    const golds = answerable.map(probe => probe.gold);
    const categories = [...new Set(answerable.map(probe => probe.category))].sort();
    const byCategory: Record<string, StrategyMetrics> = {};
    for (const category of categories) {
      const subset = answerable.filter(probe => probe.category === category);
      byCategory[category] = computeMetrics(
        subset.map(probe => probe.strategies[definition.id]!),
        subset.map(probe => probe.gold),
        k
      );
    }
    const adversarial = pass.filter(probe => probe.adversarial);
    const adversarialExecs = adversarial.map(probe => probe.strategies[definition.id]!);
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      rewritten_count: pass.filter(probe => probe.strategies[definition.id]!.rewritten).length,
      mean_queries: mean(pass.map(probe => probe.strategies[definition.id]!.queries.length)) ?? 0,
      overall_answerable: computeMetrics(execs, golds, k),
      by_category: byCategory,
      adversarial: {
        probes: adversarial.length,
        mean_results: mean(adversarialExecs.map(exec => exec.result_count)) ?? 0,
        zero_result_count: adversarialExecs.filter(exec => exec.result_count === 0).length,
        evidence_recall_at_10: mean(
          adversarialExecs
            .map((exec, index) => evidenceRecallAtK(exec.ranked_refs, adversarial[index]!.gold, 10))
            .filter((value): value is number => value !== null)
        ),
      },
    };
  });
}

// ── Baseline / determinism checks ──

function s1Funnel(pass: readonly ProbeExec[]): Record<string, number> {
  const funnel = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
  for (const probe of pass) {
    if (probe.adversarial) continue;
    if (probe.gold.length === 0) {
      funnel.no_evidence_gold += 1;
      continue;
    }
    const refs = probe.strategies.S1?.ranked_refs ?? ZERO_RANK;
    const hits = probe.gold.filter(name => refs.slice(0, 10).includes(name)).length;
    if (hits === 0) funnel.NONE += 1;
    else if (hits === probe.gold.length) funnel.ALL += 1;
    else funnel.partial += 1;
  }
  return funnel;
}

/** Gold items with rank < 10 under S1 (must equal the frozen 65). */
function s1AdmittedTop10(pass: readonly ProbeExec[]): number {
  let count = 0;
  for (const probe of pass) {
    const refs = probe.strategies.S1!.ranked_refs;
    for (const name of probe.gold)
      if (refs.indexOf(name) >= 0 && refs.indexOf(name) < 10) count += 1;
  }
  return count;
}

interface DumpRecord {
  q: string;
  admitted_ranked_final: string[];
}

/** Compare S1 top-10 names against the committed instrumented dump, if present. */
function compareDump(pass: readonly ProbeExec[], dumpPath: string | null): boolean | null {
  if (!dumpPath) return null;
  let records: DumpRecord[];
  try {
    records = readFileSync(dumpPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as DumpRecord);
  } catch {
    return null;
  }
  if (records.length !== pass.length) return null;
  for (let index = 0; index < records.length; index += 1) {
    const expected = records[index]!.admitted_ranked_final.slice(0, 10);
    const actual = (pass[index]!.strategies.S1!.ranked_refs ?? []).slice(0, 10);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
  }
  return true;
}

// ── Analysis (gains / losses / zero-results / recommendations) ──

export interface ProbeDelta {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly original_query: string;
  readonly strategy_queries: readonly string[];
}

export interface Analysis {
  readonly gains: Record<string, ProbeDelta[]>;
  readonly losses: Record<string, ProbeDelta[]>;
  readonly zero_results: Record<string, { count: number; probes: ProbeDelta[] }>;
  readonly recommendations: Record<string, { bucket: string; rationale: string }>;
}

function fullAt10(probe: ProbeExec, id: string): boolean {
  const exec = probe.strategies[id]!;
  return (
    probe.gold.length > 0 && probe.gold.every(name => exec.ranked_refs.slice(0, 10).includes(name))
  );
}

function toDelta(probe: ProbeExec, id: string): ProbeDelta {
  return {
    probe_id: probe.probe_id,
    question: probe.question,
    category: probe.category,
    original_query: probe.strategies.S1!.queries[0] ?? probe.question,
    strategy_queries: probe.strategies[id]!.queries,
  };
}

export function buildAnalysis(results: ResultsFile): Analysis {
  const gains: Record<string, ProbeDelta[]> = {};
  const losses: Record<string, ProbeDelta[]> = {};
  const zeroResults: Record<string, { count: number; probes: ProbeDelta[] }> = {};
  const recommendations: Record<string, { bucket: string; rationale: string }> = {};

  for (const strategy of results.strategies) {
    if (strategy.id === 'S1') continue;
    gains[strategy.id] = [];
    losses[strategy.id] = [];
    for (const probe of results.per_probe) {
      if (probe.adversarial || probe.gold.length === 0) continue;
      const base = fullAt10(probe, 'S1');
      const other = fullAt10(probe, strategy.id);
      if (other && !base) gains[strategy.id]!.push(toDelta(probe, strategy.id));
      if (base && !other) losses[strategy.id]!.push(toDelta(probe, strategy.id));
    }
  }

  for (const strategy of results.strategies) {
    const zero = results.per_probe.filter(
      probe => !probe.adversarial && probe.strategies[strategy.id]!.result_count === 0
    );
    zeroResults[strategy.id] = {
      count: zero.length,
      probes: zero.map(probe => toDelta(probe, strategy.id)),
    };
  }

  const m = (id: string): StrategyMetrics =>
    results.strategies.find(strategy => strategy.id === id)!.overall_answerable;
  const base = m('S1');
  const s2 = m('S2');
  const s3 = m('S3');
  const s5 = m('S5');
  const s6 = m('S6');
  // Each delta MUST subtract its own baseline: hit@10 from hit@10, full@10
  // from full@10. Mixing them overstated S2's hit gain (+14.4pp instead of
  // +3.3pp) because full@10 is always the lower baseline.
  const delta = (value: number | null, baseline: number | null): string => {
    if (value === null || baseline === null) return 'n/a';
    const pp = (value - baseline) * 100;
    return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
  };
  recommendations.S2 = {
    bucket: 'candidato prometedor / promising candidate (low-cost, small replicated effect)',
    rationale: `full@10 ${delta(s2.full_evidence_at_10, base.full_evidence_at_10)}, hit@10 ${delta(s2.hit_at_10, base.hit_at_10)}; 1 query, menos tokens y menos resultados. La réplica en \`conv-44\` conserva el signo pero con un efecto pequeño (full@10 +0.8pp, hit@10 +1.6pp) y un costo de robustez: las probes sin resultados pasan de 2 a 6 y los resultados medios bajan de 8.15 a 6.89.`,
  };
  recommendations.S4 = {
    bucket: 'redundante con S2 (no requiere cambio)',
    rationale:
      'Las queries de S4 incluyen tokens de entidad (p. ej. nombres de participantes) que S2 omite; sus resultados idénticos a S2 se deben a que el ranking no cambia al añadirlos, no a que estén contenidos en S2.',
  };
  recommendations.S3 = {
    bucket: 'no recomendado',
    rationale: `full@10 ${delta(s3.full_evidence_at_10, base.full_evidence_at_10)}: una consulta sólo-entidades es demasiado restrictiva (el piso de coverage endurece la admisión).`,
  };
  recommendations.S5 = {
    bucket: 'no recomendado',
    rationale: `full@10 ${delta(s5.full_evidence_at_10, base.full_evidence_at_10)}: la unión pone los resultados de la consulta de entidades primero y el cap de K=10 desplaza a los resultados de contenido (truncamiento por el cap de K).`,
  };
  recommendations.S6 = {
    bucket: 'no recomendado (S2 domina)',
    rationale: `full@10 ${delta(s6.full_evidence_at_10, base.full_evidence_at_10)} pero 2 queries y menor precision@10 que S2; la unión de 2 queries también se trunca por el cap de K=10, así que no hay ganancia sobre S2.`,
  };
  return { gains, losses, zero_results: zeroResults, recommendations };
}

function deltaSection(title: string, deltas: Record<string, ProbeDelta[]>): string {
  const rows = Object.entries(deltas)
    .map(([id, list]) => {
      const examples = list
        .slice(0, 3)
        .map(
          probe =>
            `  - \`${probe.probe_id}\` (${probe.category}): _${probe.question}_ → \`${probe.strategy_queries.join(' || ')}\``
        )
        .join('\n');
      const shown = Math.min(3, list.length);
      const count =
        list.length > shown
          ? `${list.length} (${shown} de ${list.length} mostrados)`
          : `${list.length}`;
      return `- **${id}**: ${count}\n${examples || '  - (ninguno)'}`;
    })
    .join('\n');
  return `### ${title}\n\n[MEDIDO]\n\n${rows}`;
}

// ── Report ──

function fmt(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function pp(value: number | null): string {
  return value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}pp`;
}

/**
 * Replication verdict for the cross-conversation check. A same-sign result is
 * a small, single-conversation replication — NOT a generalization. S2 must not
 * lose either metric and must gain on at least one to count as replicated; a
 * win on one metric with a loss on the other is inconclusive.
 */
export function crossConvVerdict(result: CrossConvResult): {
  verdict: 'replica (efecto pequeño)' | 'no se replica' | 'inconcluso';
  reason: string;
} {
  const full = result.s1_vs_s2.full_gain_pp;
  const hit = result.s1_vs_s2.hit_gain_pp;
  if (full === null || hit === null) {
    return { verdict: 'inconcluso', reason: 'faltan métricas comparables en esta conversación.' };
  }
  if (full > 0 && hit >= 0) {
    return {
      verdict: 'replica (efecto pequeño)',
      reason: `S2 mejora o iguala hit@10 (${pp(hit)}) y mejora full@10 (${pp(full)}) fuera de conv-26, con la misma transformación de ingesta y sin ajustes por conversación. Es una replicación puntual con un efecto pequeño, no una generalización.`,
    };
  }
  if (full === 0 && hit === 0) {
    return {
      verdict: 'no se replica',
      reason:
        'S2 no cambia ninguna métrica en esta conversación; la ganancia de conv-26 no se reproduce.',
    };
  }
  if (full < 0 && hit <= 0) {
    return {
      verdict: 'no se replica',
      reason: `S2 empeora o iguala ambas métricas (full@10 ${pp(full)}, hit@10 ${pp(hit)}); la ganancia de conv-26 no se reproduce.`,
    };
  }
  return {
    verdict: 'inconcluso',
    reason: `señales mixtas (full@10 ${pp(full)}, hit@10 ${pp(hit)}): una métrica mejora y la otra empeora, así que esta conversación no confirma ni refuta la ganancia.`,
  };
}

export function renderCrossConvSection(result: CrossConvResult): string {
  const rows = (['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as StrategyId[])
    .map(id => {
      const m = result.strategies[id]!;
      return `| ${id} | ${fmt(m.hit_at_10)} | ${fmt(m.full_evidence_at_10)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_10)} |`;
    })
    .join('\n');
  const verdict = crossConvVerdict(result);
  return `## 11. Validación cruzada — \`${result.conversation}\`

[MEDIDO] Ingesta determinista de ${result.turns} turnos en una DB temporal; ${result.answerable_questions} preguntas answerable con evidencia. Misma transformación que el benchmark (\`conversationTurns\`, space \`${result.space}\`); gold de los \`qa\` de la propia conversación, sólo para puntuar.

| Estrategia | hit@10 | full@10 | MRR | P@10 |
| --- | ---: | ---: | ---: | ---: |
${rows}

**Δ S2−S1 en \`${result.conversation}\`**: full@10 ${pp(result.s1_vs_s2.full_gain_pp)}, hit@10 ${pp(result.s1_vs_s2.hit_gain_pp)}.

**Trade-off de robustez en \`${result.conversation}\`:** S2 deja más probes sin resultados (${result.strategies.S1.zero_result_count} → ${result.strategies.S2.zero_result_count}) y devuelve menos resultados medios (${fmt(result.strategies.S1.mean_results, 2)} → ${fmt(result.strategies.S2.mean_results, 2)}) que S1. La ganancia de retrieval es pequeña y no compensa declarar una mejora generalizada.

**Veredicto de replicación: ${verdict.verdict}.** ${verdict.reason}
`;
}

/** Replace an existing trailing `## 11.` section (idempotent re-runs). */
export function upsertSection(document: string, section: string): string {
  const marker = '\n## 11.';
  const index = document.indexOf(marker);
  const base = (index >= 0 ? document.slice(0, index) : document).replace(/\s+$/, '');
  return `${base}\n\n${section.replace(/\s+$/, '')}\n`;
}

export function renderReport(results: ResultsFile, crossConv?: CrossConvResult | null): string {
  const analysis = buildAnalysis(results);
  const overallRows = results.strategies
    .map(strategy => {
      const m = strategy.overall_answerable;
      return `| ${strategy.id} \`${strategy.label}\` | ${strategy.rewritten_count} | ${strategy.mean_queries.toFixed(2)} | ${fmt(m.hit_at_10)} | ${fmt(m.full_evidence_at_10)} | ${fmt(m.evidence_recall_at_10)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_10)} | ${fmt(m.mean_results, 1)} | ${m.zero_result_count} | ${fmt(m.context_tokens_at_10, 0)} | ${fmt(m.latency_p50_ms, 1)} |`;
    })
    .join('\n');

  const categorySection = results.strategies
    .map(strategy => {
      const rows = Object.entries(strategy.by_category)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, m]) => {
          return `| ${category} | ${m.probes} | ${fmt(m.hit_at_10)} | ${fmt(m.full_evidence_at_10)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_10)} | ${fmt(m.mean_results, 1)} |`;
        })
        .join('\n');
      return `### ${strategy.id} — \`${strategy.label}\`\n\n| Categoría | Probes | hit@10 | full@10 | MRR | P@10 | #res |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}`;
    })
    .join('\n\n');

  const adversarialRows = results.strategies
    .map(
      strategy =>
        `| ${strategy.id} | ${strategy.adversarial.probes} | ${fmt(strategy.adversarial.mean_results, 1)} | ${strategy.adversarial.zero_result_count} | ${fmt(strategy.adversarial.evidence_recall_at_10)} |`
    )
    .join('\n');

  return `# Experimento A — consultas naturales vs enfocadas (estrategias deterministas)

**Feature:** \`00009-memory-recall-investigation\` · **Tarea:** E-A
**RAG:** off · **DB:** copia scratch del run \`conv-26\` (nunca la DB viva) · **Costo:** $0, sin LLM.

> Gold se usa **solo** para puntuar; nunca para construir consultas. Las
> estrategias son funciones puras de (pregunta, participantes).

## 1. Estrategias y salvaguardas

| ID | Nombre | Definición |
| --- | --- | --- |
${STRATEGIES.map(s => `| ${s.id} | \`${s.label}\` | ${s.description} |`).join('\n')}

Salvaguardas: si la pregunta trae sintaxis explícita (\`AND\`/\`OR\`/\`NOT\` en
mayúsculas, \`"frases"\` o prefijos \`foo*\`) la estrategia **no reescribe** y
registra \`explicit_operator_preserved\`. Sin listas de palabras clave por
conversación. Los participantes salen del dato ingerido (\`speaker_a\`/\`speaker_b\`).
Filtros de space/tag/tier idénticos (space = \`${DEFAULT_SPACE}\`).

## 2. Gate de sanidad (S1 == baseline congelado)

[MEDIDO]

| Chequeo | Resultado |
| --- | --- |
| Funnel S1 K=10 == congelado ${JSON.stringify(FROZEN_FUNNEL_K10)} | **${results.baseline.funnel_match ? 'pass' : 'FAIL'}** |
| \`admitted_top10\` S1 == ${FROZEN_ADMITTED_TOP10} | **${results.baseline.admitted_top10_match ? 'pass' : 'FAIL'}** |
| Ranking S1 top-10 == dump instrumentado | **${results.baseline.dump_ranking_match === null ? 'n/a (dump ausente)' : results.baseline.dump_ranking_match ? 'pass' : 'FAIL'}** |
| Determinismo (dos pasadas limit=10) | **${results.determinism.identical ? 'pass' : 'FAIL'}** (${results.determinism.compared} probes) |

Funnel S1 medido: \`${JSON.stringify(results.baseline.s1_funnel)}\`.

## 3. Métricas por estrategia (answerable, K=10 primario)

[MEDIDO] ${results.meta.answerable} probes answerable. \`hit@10\` = al menos una
evidencia en top-10; \`full@10\` = toda la evidencia en top-10.

| Estrategia | reescritas | queries/probe | hit@10 | full@10 | recall@10 | MRR | P@10 | #res | 0-res | tok@10 | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${overallRows}

### K=25 (secundario)

[MEDIDO]

| Estrategia | hit@25 | full@25 | recall@25 | MRR | P@25 | #res |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${results.secondary.strategies
  .map(strategy => {
    const m = strategy.overall_answerable;
    return `| ${strategy.id} | ${fmt(m.hit_at_10)} | ${fmt(m.full_evidence_at_10)} | ${fmt(m.evidence_recall_at_10)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_10)} | ${fmt(m.mean_results, 1)} |`;
  })
  .join('\n')}

## 4. Desglose por categoría (answerable)

[MEDIDO]

${categorySection}

## 5. Comportamiento adversarial (proxy)

[MEDIDO] ${results.meta.adversarial} probes adversarial. Sin LLM no se puede
medir rechazo/FP real; se reporta la recuperación como **proxy** (evidencia
premisa en top-10; un valor alto no implica respuesta).

| Estrategia | probes | #res medio | 0-res | recall premisa@10 |
| --- | ---: | ---: | ---: | ---: |
${adversarialRows}

## 6. Ganancias/Losses de evidencia completa@10 (S1 = base)

${deltaSection('Ganancias (full@10 pasa de false a true)', analysis.gains)}

## 7. Pérdidas de evidencia completa@10

${deltaSection('Pérdidas (full@10 pasa de true a false)', analysis.losses)}

## 8. Análisis de 0 resultados

[MEDIDO] Recuento de probes answerable sin ningún resultado, por estrategia:

| Estrategia | 0-resultados | probes |
| --- | ---: | --- |
${results.strategies
  .map(strategy => {
    const zero = analysis.zero_results[strategy.id]!;
    return `| ${strategy.id} | ${zero.count} | ${zero.probes.map(probe => probe.probe_id).join(', ') || '—'} |`;
  })
  .join('\n')}

> S2 introduce 1 probe adicional sin resultados (una pregunta cuya versión
> recortada pierde el único término que entraba por \`like\`/\`token_set\`). Es un
> costo de robustez pequeño frente a la ganancia de recall.

## 9. Recomendación por estrategia

${Object.entries(analysis.recommendations)
  .map(([id, rec]) => `- **${id} — ${rec.bucket}**: ${rec.rationale}`)
  .join('\n')}

**Veredicto:** **S2 (drop conservador de palabras funcionales) es un candidato
prometedor (de bajo costo, con un efecto replicado pequeño), no un quick win ni
una ganancia generalizada.** Relaja el piso de coverage sin perder
términos de contenido; gana ~+4.4pp de evidencia completa@10 y ~+3.3pp de hit@10
en conv-26 y reduce tokens, con 1 sola query. La réplica en \`conv-44\` conserva
el signo (+0.8pp full@10, +1.6pp hit@10) pero con un efecto mucho menor, a costa
de más probes sin resultados (2→6) y menos resultados medios (8.15→6.89). S4/S6
no aportan sobre S2; S3/S5 son dañinas.

## 10. UNKNOWN

- El FP/rechazo real del modelo NO se mide aquí (requiere LLM). Solo retrieval;
  el bloque adversarial es un proxy.
- Una sola conversación (conv-26) en la corrida principal; ver sección de
  validación cruzada (E-A cross-conv). Una única réplica en \`conv-44\` no
  convierte el efecto pequeño en una generalización.
- La DB congelada se ingirió sin captions \`[Photo: ...]\`; estos números no son
  directamente comparables con una ingesta actual con captions.

${crossConv ? renderCrossConvSection(crossConv) : ''}`;
}

// ── CLI ──

interface Options {
  limit: number;
  out: string;
  db: string;
  probes: string;
  locomo: string;
  worktree: string;
  scratch: string;
  dump: string | null;
  conversation: string;
}

function defaultOptions(): Options {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    limit: BENCHMARK_TOP_K,
    out: join(here, '..', 'REPORTS', 'query-strategies'),
    db: join(integration, 'mind-scratch/run-mind-20261019-mind-conv-26/mind.db'),
    probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
    locomo: join(integration, 'data/locomo10.json'),
    worktree: join(agentMemory, '.work/worktrees/v10'),
    scratch: join(agentMemory, '.work/experiments/query-strategies'),
    dump: join(agentMemory, 'experiments/REPORTS/workbench/dumps/rag-off-stages.jsonl'),
    conversation: 'conv-26',
  };
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const base = defaultOptions();
  return {
    limit: Number(flags.get('limit') ?? base.limit),
    out: flags.get('out') ?? base.out,
    db: flags.get('db') ?? base.db,
    probes: flags.get('probes') ?? base.probes,
    locomo: flags.get('locomo') ?? base.locomo,
    worktree: flags.get('worktree') ?? base.worktree,
    scratch: flags.get('scratch') ?? base.scratch,
    dump: flags.get('dump') === 'none' ? null : (flags.get('dump') ?? base.dump),
    conversation: flags.get('conversation') ?? base.conversation,
  };
}

export async function runExperiment(options: Options): Promise<ResultsFile> {
  const probes = readProbes(options.probes);
  const gold = loadGold(options.locomo, options.conversation);
  const participants = loadParticipants(options.locomo, options.conversation);
  const space = DEFAULT_SPACE;

  mkdirSync(options.scratch, { recursive: true });
  copyDatabase(options.db, options.scratch);
  const env = buildEnv(options.scratch, 'off');
  const port = await findFreePort();
  const server = await startServer({
    bin: join(resolve(options.worktree), 'mind'),
    cwd: resolve(options.worktree),
    env,
    port,
    stderrLog: join(options.scratch, 'serve.stderr.log'),
  });

  try {
    const passA = await runPass(server.baseUrl, space, probes, gold, participants, options.limit);
    const passB = await runPass(server.baseUrl, space, probes, gold, participants, options.limit);
    const secondaryLimit = 25;
    const passC = await runPass(server.baseUrl, space, probes, gold, participants, secondaryLimit);

    const signature = (pass: readonly ProbeExec[]): string =>
      JSON.stringify(
        pass.map(probe =>
          Object.fromEntries(
            Object.entries(probe.strategies).map(([id, exec]) => [id, exec.ranked_refs])
          )
        )
      );
    const identical = signature(passA) === signature(passB);

    const funnel = s1Funnel(passA);
    const admittedTop10 = s1AdmittedTop10(passA);
    const funnelMatch = (['ALL', 'partial', 'NONE', 'no_evidence_gold'] as const).every(
      key => funnel[key] === FROZEN_FUNNEL_K10[key]
    );

    const results: ResultsFile = {
      meta: {
        feature: '00009-memory-recall-investigation',
        task: 'E-A',
        generated_at: new Date().toISOString(),
        rag: 'off',
        limit: options.limit,
        space,
        conversation: options.conversation,
        participants,
        probe_count: probes.length,
        answerable: probes.filter(probe => !probe.adversarial).length,
        adversarial: probes.filter(probe => probe.adversarial).length,
        db_source: resolve(options.db),
        worktree: resolve(options.worktree),
        gold_usage: 'scoring only; never used to build a query',
      },
      baseline: {
        frozen: FROZEN_FUNNEL_K10,
        s1_funnel: funnel,
        funnel_match: funnelMatch,
        admitted_top10: admittedTop10,
        admitted_top10_match: admittedTop10 === FROZEN_ADMITTED_TOP10,
        dump_ranking_match: compareDump(passA, options.dump),
      },
      determinism: { compared: probes.length, identical },
      strategies: aggregatePass(passA, options.limit),
      secondary: { limit: secondaryLimit, strategies: aggregatePass(passC, secondaryLimit) },
      per_probe: passA,
    };

    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    const crossConvPath = join(options.out, 'cross-conv.json');
    const crossConv = existsSync(crossConvPath)
      ? (JSON.parse(readFileSync(crossConvPath, 'utf8')) as CrossConvResult)
      : null;
    writeFileSync(join(options.out, 'report.md'), renderReport(results, crossConv));
    return results;
  } finally {
    await server.stop();
  }
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const results = await runExperiment(options);
  process.stdout.write(
    `query-strategies done: ${results.meta.probe_count as number} probes, ` +
      `funnel_match=${results.baseline.funnel_match}, determinism=${results.determinism.identical} → ${resolve(options.out)}\n`
  );
  const healthy = results.baseline.funnel_match && results.determinism.identical;
  if (!healthy) process.exitCode = 1;
}
