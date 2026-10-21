// Experiment B runner — memory representation variants on the SAME conv-26 data.
//
// For each representation (V1/V2/V2n/V3) the script:
//   1. builds a FRESH temporary SQLite DB through the pinned v10 `mind` CLI
//      (deterministic ingestion, RAG off, tier 3);
//   2. starts the pinned `mind serve` on that isolated DB;
//   3. replays the same 120 conv-26 probes twice at K=10 and once at K=25;
//   4. scores retrieval against the LoCoMo gold evidence (scoring only).
//
// V1 additionally replays at limit=500 to reproduce the frozen baseline gate
// and compares its per-probe top-10 against the committed instrumented dump.
//
// Usage:
//   bun run experiments/representations/run.ts [--out <dir>] [--worktree <dir>]
//     [--conversation conv-26] [--scratch <dir>]

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import { buildTurnContent, conversationTurns, type TurnRecord } from '../../src/locomo/ingest';
import { MindCli, type MindPaths } from '../../src/mind/cli';
import { verifyMemorySet } from '../../src/mind/inspect';
import {
  buildEnv,
  DEFAULT_SPACE,
  findFreePort,
  readProbes,
  startServer,
  type Probe,
} from '../replay/replay';

import {
  buildSessionMemories,
  buildTurnMemories,
  compareTop10,
  evaluateProbe,
  matchEvidence,
  metricDelta,
  REPRESENTATIONS,
  summarizeFunnel,
  summarizeItemLabels,
  summarizeMetrics,
  type EvidenceMatcher,
  type EvaluatedProbe,
  type FunnelCounts,
  type ItemLabelCounts,
  type MemoryDraft,
  type MetricDelta,
  type MetricsSummary,
  type RepresentationId,
  type RetrievedMemory,
} from './representations';

// ── Frozen V1 gate ──

export const FROZEN_FUNNEL_K10 = { ALL: 41, partial: 10, NONE: 39, no_evidence_gold: 2 } as const;
export const FROZEN_ITEM_LABELS = {
  admitted_top10: 65,
  admitted_outside_top10: 17,
  dropped_by_admission: 28,
  dropped_by_coverage: 0,
  excluded_by_not: 0,
  never_candidate: 35,
} as const;

// ── Dataset scaffolding ──

interface LocomoSample {
  sample_id: string;
  conversation: { speaker_a?: string; speaker_b?: string };
  qa: Array<{ question: string; evidence?: string[]; category: number }>;
}

interface GoldEntry {
  readonly evidence: readonly string[];
}

export function loadGold(locomoPath: string, conversation: string): Map<string, GoldEntry> {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as LocomoSample[];
  const sample = dataset.find(entry => entry.sample_id === conversation);
  if (!sample) throw new Error(`conversation ${conversation} not found`);
  const map = new Map<string, GoldEntry>();
  for (const qa of sample.qa) map.set(qa.question.trim(), { evidence: qa.evidence ?? [] });
  return map;
}

export function loadParticipants(locomoPath: string, conversation: string): string[] {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as LocomoSample[];
  const sample = dataset.find(entry => entry.sample_id === conversation);
  return [sample?.conversation.speaker_a, sample?.conversation.speaker_b].filter(
    (name): name is string => typeof name === 'string' && name.length > 0
  );
}

// ── Replay ──

export interface CapturedProbe {
  readonly probe: Probe;
  readonly ranked: readonly RetrievedMemory[];
  readonly latencyMs: number;
}

function mapItems(items: unknown): RetrievedMemory[] {
  const memories: RetrievedMemory[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = record.content;
    if (typeof content !== 'string' || !content.trim()) continue;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    memories.push({
      name: typeof record.name === 'string' ? record.name : '',
      content,
      tags,
    });
  }
  return memories;
}

async function replayPass(
  baseUrl: string,
  probes: readonly Probe[],
  space: string,
  limit: number
): Promise<CapturedProbe[]> {
  const out: CapturedProbe[] = [];
  for (const probe of probes) {
    const params = new URLSearchParams({ q: probe.question, space, limit: String(limit) });
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);
    if (!response.ok)
      throw new Error(`/api/search status ${response.status} for ${probe.probe_id}`);
    const items = (await response.json()) as unknown;
    out.push({ probe, ranked: mapItems(items), latencyMs: performance.now() - started });
  }
  return out;
}

function signature(pass: readonly CapturedProbe[]): string {
  return JSON.stringify(pass.map(entry => entry.ranked.map(memory => [memory.name, memory.tags])));
}

// ── Ingestion ──

export interface IngestOutcome {
  readonly ingestMs: number;
  readonly verification: ReturnType<typeof verifyMemorySet>;
}

export async function ingestFresh(
  bin: string,
  cwd: string,
  dir: string,
  space: string,
  drafts: readonly MemoryDraft[]
): Promise<IngestOutcome> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const paths: MindPaths = {
    dataDir: dir,
    dbPath: join(dir, 'mind.db'),
    syncRoot: join(dir, 'syncroot'),
  };
  const cli = new MindCli({ bin, paths, cwd, rag: false });
  await cli.exec(['create', space, `LoCoMo ${space}`, '--tags', 'locomo']);
  const started = performance.now();
  for (const draft of drafts) {
    await cli.exec(
      ['add', space, draft.name, draft.content, '--tags', draft.tags.join(','), '--tier', '3'],
      { timeoutMs: 30_000 }
    );
  }
  const ingestMs = performance.now() - started;
  const verification = verifyMemorySet(
    paths.dbPath,
    space,
    drafts.map(draft => draft.name)
  );
  if (!verification.ok) throw new Error(`ingestion verification failed: ${verification.detail}`);
  return { ingestMs, verification };
}

export interface DbSize {
  readonly database_bytes: number;
  readonly wal_bytes: number;
  readonly total_bytes: number;
}

export function measureDb(dbPath: string): DbSize {
  try {
    const db = new Database(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // best effort: a non-checkpointed DB still gets measured below
  }
  const size = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
  const database = size(dbPath);
  const wal = size(`${dbPath}-wal`);
  return { database_bytes: database, wal_bytes: wal, total_bytes: database + wal };
}

// ── Variant execution ──

export interface VariantReport {
  readonly id: RepresentationId;
  readonly label: string;
  readonly description: string;
  readonly memory_count: number;
  readonly db: DbSize;
  readonly ingest_ms: number;
  readonly determinism: { readonly compared: number; readonly identical: boolean };
  readonly overall: MetricsSummary;
  readonly by_category: Record<string, MetricsSummary>;
  readonly adversarial: MetricsSummary;
  readonly secondary_overall: MetricsSummary;
  readonly secondary_by_category: Record<string, MetricsSummary>;
  readonly per_probe: readonly {
    readonly probe_id: string;
    readonly question: string;
    readonly category: string;
    readonly adversarial: boolean;
    readonly gold: readonly string[];
    readonly ranked_refs: readonly string[];
    readonly evidence_ranks: Record<string, number>;
    readonly result_count: number;
    readonly latency_ms: number;
  }[];
}

export interface GateReport {
  readonly funnel: FunnelCounts;
  readonly funnel_expected: typeof FROZEN_FUNNEL_K10;
  readonly funnel_match: boolean;
  readonly item_labels: ItemLabelCounts;
  readonly frozen_item_labels: typeof FROZEN_ITEM_LABELS;
  readonly absent_matches_frozen_split: boolean;
  readonly top10_vs_dump: {
    readonly compared: number;
    readonly mismatches: number;
    readonly match: boolean;
  };
}

export interface EffectReport {
  readonly id: 'name' | 'tags' | 'combined' | 'grouping';
  readonly label: string;
  readonly baseline: RepresentationId;
  readonly variant: RepresentationId;
  readonly overall: MetricDelta;
  readonly by_category: Record<string, MetricDelta>;
}

export interface ResultsFile {
  readonly meta: Record<string, unknown>;
  readonly gate: GateReport;
  readonly variants: readonly VariantReport[];
  readonly effects: readonly EffectReport[];
}

interface Options {
  readonly out: string;
  readonly worktree: string;
  readonly conversation: string;
  readonly scratch: string;
  readonly locomo: string;
  readonly probes: string;
  readonly dump: string;
  readonly space: string;
}

function defaultOptions(): Options {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    out: join(here, '..', 'REPORTS', 'representations'),
    worktree: join(agentMemory, '.work/worktrees/v10'),
    conversation: 'conv-26',
    scratch: join(agentMemory, '.work/experiments/representations'),
    locomo: join(integration, 'data/locomo10.json'),
    probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
    dump: join(agentMemory, 'experiments/REPORTS/workbench/dumps/rag-off-stages.jsonl'),
    space: DEFAULT_SPACE,
  };
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    index += 1;
  }
  const base = defaultOptions();
  return {
    out: flags.get('out') ?? base.out,
    worktree: flags.get('worktree') ?? base.worktree,
    conversation: flags.get('conversation') ?? base.conversation,
    scratch: flags.get('scratch') ?? base.scratch,
    locomo: flags.get('locomo') ?? base.locomo,
    probes: flags.get('probes') ?? base.probes,
    dump: flags.get('dump') ?? base.dump,
    space: flags.get('space') ?? base.space,
  };
}

function matcherFor(id: RepresentationId, nameToDia: ReadonlyMap<string, string>): EvidenceMatcher {
  if (id === 'V1') return { kind: 'dia-name' };
  if (id === 'V2') return { kind: 'dia-tag' };
  if (id === 'V2n') return { kind: 'registry', nameToDia };
  return { kind: 'containment' };
}

function evaluateCaptured(
  pass: readonly CapturedProbe[],
  gold: Map<string, GoldEntry>,
  matcher: EvidenceMatcher,
  k: number
): EvaluatedProbe[] {
  return pass.map(entry => ({
    evaluation: evaluateProbe(
      entry.ranked,
      gold.get(entry.probe.question.trim())?.evidence ?? [],
      matcher,
      k
    ),
    latencyMs: entry.latencyMs,
  }));
}

function groupByCategory(
  pass: readonly CapturedProbe[],
  gold: Map<string, GoldEntry>,
  matcher: EvidenceMatcher,
  k: number,
  adversarial: boolean
): Record<string, MetricsSummary> {
  const categories = [
    ...new Set(
      pass
        .filter(entry => entry.probe.adversarial === adversarial)
        .map(entry => entry.probe.category)
    ),
  ].sort();
  const out: Record<string, MetricsSummary> = {};
  for (const category of categories) {
    const subset = pass.filter(
      entry => entry.probe.adversarial === adversarial && entry.probe.category === category
    );
    out[category] = summarizeMetrics(evaluateCaptured(subset, gold, matcher, k), k);
  }
  return out;
}

function toPerProbe(
  pass: readonly CapturedProbe[],
  gold: Map<string, GoldEntry>,
  matcher: EvidenceMatcher
): VariantReport['per_probe'] {
  return pass.map(entry => {
    const evidence = gold.get(entry.probe.question.trim())?.evidence ?? [];
    const match = matchEvidence(entry.ranked, evidence, matcher);
    return {
      probe_id: entry.probe.probe_id,
      question: entry.probe.question,
      category: entry.probe.category,
      adversarial: entry.probe.adversarial,
      gold: evidence,
      ranked_refs: entry.ranked.map(memory => memory.name),
      evidence_ranks: Object.fromEntries(match.ranks),
      result_count: entry.ranked.length,
      latency_ms: entry.latencyMs,
    };
  });
}

async function runVariant(
  id: RepresentationId,
  drafts: readonly MemoryDraft[],
  options: Options,
  probes: readonly Probe[],
  gold: Map<string, GoldEntry>,
  nameToDia: ReadonlyMap<string, string>
): Promise<VariantReport> {
  const definition = REPRESENTATIONS.find(candidate => candidate.id === id)!;
  const dir = join(options.scratch, id.toLowerCase());
  const bin = join(options.worktree, 'mind');
  const ingest = await ingestFresh(bin, options.worktree, dir, options.space, drafts);
  const paths: MindPaths = {
    dataDir: dir,
    dbPath: join(dir, 'mind.db'),
    syncRoot: join(dir, 'syncroot'),
  };
  const env = buildEnv(dir, 'off');
  const port = await findFreePort();
  const server = await startServer({
    bin,
    cwd: options.worktree,
    env,
    port,
    stderrLog: join(dir, 'serve.stderr.log'),
  });
  const matcher = matcherFor(id, nameToDia);
  try {
    const passA = await replayPass(server.baseUrl, probes, options.space, 10);
    const passB = await replayPass(server.baseUrl, probes, options.space, 10);
    const pass25 = await replayPass(server.baseUrl, probes, options.space, 25);

    const answerable = passA.filter(entry => !entry.probe.adversarial);
    const adversarial = passA.filter(entry => entry.probe.adversarial);
    const answerable25 = pass25.filter(entry => !entry.probe.adversarial);

    return {
      id,
      label: definition.label,
      description: definition.description,
      memory_count: drafts.length,
      db: measureDb(paths.dbPath),
      ingest_ms: ingest.ingestMs,
      determinism: {
        compared: passA.length,
        identical: signature(passA) === signature(passB),
      },
      overall: summarizeMetrics(evaluateCaptured(answerable, gold, matcher, 10), 10),
      by_category: groupByCategory(passA, gold, matcher, 10, false),
      adversarial: summarizeMetrics(evaluateCaptured(adversarial, gold, matcher, 10), 10),
      secondary_overall: summarizeMetrics(evaluateCaptured(answerable25, gold, matcher, 25), 25),
      secondary_by_category: groupByCategory(pass25, gold, matcher, 25, false),
      per_probe: toPerProbe(passA, gold, matcher),
    };
  } finally {
    await server.stop();
  }
}

/** The historical benchmark DB has no `[Photo: ...]` captions; strip them for the gate. */
export function withoutPhotoCaptions(turns: readonly TurnRecord[]): TurnRecord[] {
  return turns.map(turn => ({
    diaId: turn.diaId,
    session: turn.session,
    speaker: turn.speaker,
    text: turn.text,
    sessionDateTime: turn.sessionDateTime,
    content: buildTurnContent(turn.sessionDateTime, turn.speaker, turn.text),
    tags: [...turn.tags],
  }));
}

export function buildGateReport(
  gatePass: readonly CapturedProbe[],
  probes: readonly Probe[],
  gold: Map<string, GoldEntry>,
  dump: readonly (readonly string[])[] | null
): GateReport {
  const matcher: EvidenceMatcher = { kind: 'dia-name' };
  const evaluations = evaluateCaptured(gatePass, gold, matcher, 10);
  const funnel = summarizeFunnel(
    gatePass
      .map((entry, index) => ({ entry, evaluation: evaluations[index]! }))
      .filter(item => !item.entry.probe.adversarial)
      .map(item => item.evaluation.evaluation)
  );
  const rankings = gatePass.map(entry => entry.ranked.map(memory => memory.name));
  const golds = gatePass.map(entry => gold.get(entry.probe.question.trim())?.evidence ?? []);
  const labels = summarizeItemLabels(rankings, golds);
  const actualTop10 = rankings.map(names => names.slice(0, 10));
  const top10 = dump
    ? compareTop10(actualTop10, dump)
    : { compared: 0, mismatches: Number.POSITIVE_INFINITY };
  const funnelMatch = (Object.keys(FROZEN_FUNNEL_K10) as (keyof FunnelCounts)[]).every(
    key => funnel[key] === FROZEN_FUNNEL_K10[key]
  );
  return {
    funnel,
    funnel_expected: FROZEN_FUNNEL_K10,
    funnel_match: funnelMatch,
    item_labels: labels,
    frozen_item_labels: FROZEN_ITEM_LABELS,
    absent_matches_frozen_split:
      labels.absent_from_ranking ===
      FROZEN_ITEM_LABELS.dropped_by_admission + FROZEN_ITEM_LABELS.never_candidate,
    top10_vs_dump: {
      compared: top10.compared,
      mismatches: top10.mismatches,
      match: top10.mismatches === 0 && top10.compared === probes.length,
    },
  };
}

/**
 * V1 gate calibration on the frozen content convention (no photo captions).
 * The committed benchmark DB was ingested before caption support, so a fresh
 * current-content V1 cannot reproduce its ranking; this run isolates the gate.
 */
async function runGateCalibration(
  turns: readonly TurnRecord[],
  participants: readonly string[],
  options: Options,
  probes: readonly Probe[],
  gold: Map<string, GoldEntry>,
  dump: readonly (readonly string[])[] | null
): Promise<GateReport> {
  const dir = join(options.scratch, 'v1f');
  const drafts = buildTurnMemories(withoutPhotoCaptions(turns), 'V1', participants);
  const bin = join(options.worktree, 'mind');
  await ingestFresh(bin, options.worktree, dir, options.space, drafts);
  const port = await findFreePort();
  const server = await startServer({
    bin,
    cwd: options.worktree,
    env: buildEnv(dir, 'off'),
    port,
    stderrLog: join(dir, 'serve.stderr.log'),
  });
  try {
    const gatePass = await replayPass(server.baseUrl, probes, options.space, 500);
    return buildGateReport(gatePass, probes, gold, dump);
  } finally {
    await server.stop();
  }
}

// ── Effects ──

function effectFor(
  id: EffectReport['id'],
  label: string,
  baseline: RepresentationId,
  variant: RepresentationId,
  reports: readonly VariantReport[]
): EffectReport {
  const base = reports.find(report => report.id === baseline)!;
  const target = reports.find(report => report.id === variant)!;
  const categories = [
    ...new Set([...Object.keys(base.by_category), ...Object.keys(target.by_category)]),
  ].sort();
  const byCategory: Record<string, MetricDelta> = {};
  for (const category of categories) {
    const left = base.by_category[category];
    const right = target.by_category[category];
    if (left && right) byCategory[category] = metricDelta(right, left);
  }
  return {
    id,
    label,
    baseline,
    variant,
    overall: metricDelta(target.overall, base.overall),
    by_category: byCategory,
  };
}

// ── Dump ──

function readDumpTop10(path: string): readonly (readonly string[])[] | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const record = JSON.parse(line) as { admitted_ranked_final?: unknown };
        return Array.isArray(record.admitted_ranked_final)
          ? (record.admitted_ranked_final as string[]).slice(0, 10)
          : [];
      });
  } catch {
    return null;
  }
}

// ── Report ──

const fmt = (value: number | null, digits = 3): string =>
  value === null ? 'n/a' : value.toFixed(digits);
const pp = (value: number | null): string =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}pp`;
const abs = (value: number | null, digits = 3): string =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const int = (value: number | null, digits = 0): string =>
  value === null ? 'n/a' : value.toFixed(digits);

function overallTable(reports: readonly VariantReport[]): string {
  return [
    '| Variante | memorias | DB KB | hit@10 | full@10 | recall@10 | MRR | P@10 | #res | 0-res | tok@10 | p50 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...reports.map(report => {
      const m = report.overall;
      return `| ${report.id} | ${report.memory_count} | ${int(report.db.total_bytes / 1024, 1)} | ${fmt(m.hit_at_k)} | ${fmt(m.full_evidence_at_k)} | ${fmt(m.evidence_recall_at_k)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_k)} | ${fmt(m.mean_results, 1)} | ${m.zero_result_count} | ${int(m.context_tokens_at_k)} | ${fmt(m.latency_p50_ms, 1)} |`;
    }),
  ].join('\n');
}

function secondaryTable(reports: readonly VariantReport[]): string {
  return [
    '| Variante | hit@25 | full@25 | recall@25 | MRR | P@25 | #res | tok@25 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...reports.map(report => {
      const m = report.secondary_overall;
      return `| ${report.id} | ${fmt(m.hit_at_k)} | ${fmt(m.full_evidence_at_k)} | ${fmt(m.evidence_recall_at_k)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_k)} | ${fmt(m.mean_results, 1)} | ${int(m.context_tokens_at_k)} |`;
    }),
  ].join('\n');
}

function categoryTables(reports: readonly VariantReport[]): string {
  const categories = [...new Set(reports.flatMap(report => Object.keys(report.by_category)))].sort(
    (a, b) => categoryOrder(a) - categoryOrder(b)
  );
  return categories
    .map(category => {
      const rows = reports.map(report => {
        const m = report.by_category[category];
        if (!m) return `| ${report.id} | n/a | n/a | n/a | n/a | n/a |`;
        return `| ${report.id} | ${fmt(m.hit_at_k)} | ${fmt(m.full_evidence_at_k)} | ${fmt(m.mrr)} | ${fmt(m.precision_at_k)} | ${int(m.context_tokens_at_k)} |`;
      });
      return `### ${category}\n\n| Variante | hit@10 | full@10 | MRR | P@10 | tok@10 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

function categoryOrder(category: string): number {
  const order = ['single-hop', 'multi-hop', 'temporal', 'open-domain', 'adversarial'];
  const index = order.indexOf(category);
  return index === -1 ? order.length : index;
}

function effectsTable(effects: readonly EffectReport[]): string {
  return [
    '| Efecto | Comparación | Δhit@10 | Δfull@10 | ΔMRR | ΔP@10 | Δtok@10 | Δ#res |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...effects.map(effect => {
      const d = effect.overall;
      return `| ${effect.id} | ${effect.variant} − ${effect.baseline} | ${pp(d.hit_at_k_pp)} | ${pp(d.full_evidence_at_k_pp)} | ${abs(d.mrr_delta)} | ${pp(d.precision_at_k_pp)} | ${abs(d.context_tokens_delta, 0)} | ${abs(d.mean_results_delta, 2)} |`;
    }),
  ].join('\n');
}

interface ExampleProbe {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly base_rank: number | null;
  readonly target_rank: number | null;
}

function firstRank(probe: VariantReport['per_probe'][number]): number | null {
  const ranks = Object.values(probe.evidence_ranks).sort((a, b) => a - b);
  return ranks[0] ?? null;
}

function fullAt10(probe: VariantReport['per_probe'][number]): boolean {
  if (probe.gold.length === 0) return false;
  return probe.gold.every(item => {
    const rank = probe.evidence_ranks[item.toLowerCase()];
    return rank !== undefined && rank < 10;
  });
}

export function pickExamples(
  reports: readonly VariantReport[],
  variant: RepresentationId,
  direction: 'gain' | 'loss',
  limit = 3
): ExampleProbe[] {
  const v1 = reports.find(report => report.id === 'V1')!;
  const target = reports.find(report => report.id === variant)!;
  const byId = new Map(target.per_probe.map(probe => [probe.probe_id, probe]));
  const out: ExampleProbe[] = [];
  for (const base of v1.per_probe) {
    if (base.adversarial || base.gold.length === 0) continue;
    const other = byId.get(base.probe_id);
    if (!other) continue;
    const baseFull = fullAt10(base);
    const otherFull = fullAt10(other);
    if (direction === 'gain' && otherFull && !baseFull) {
      out.push({
        probe_id: base.probe_id,
        question: base.question,
        category: base.category,
        base_rank: firstRank(base),
        target_rank: firstRank(other),
      });
    }
    if (direction === 'loss' && baseFull && !otherFull) {
      out.push({
        probe_id: base.probe_id,
        question: base.question,
        category: base.category,
        base_rank: firstRank(base),
        target_rank: firstRank(other),
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

function examplesBlock(reports: readonly VariantReport[]): string {
  const block = (title: string, variant: RepresentationId, direction: 'gain' | 'loss'): string => {
    const examples = pickExamples(reports, variant, direction);
    if (examples.length === 0) return `**${title}:** ninguno.`;
    const rows = examples
      .map(
        example =>
          `- \`${example.probe_id}\` (${example.category}): _${example.question}_ — primer rank evidencia V1=${example.base_rank ?? 'fuera top-10'}, ${variant}=${example.target_rank ?? 'fuera top-10'}`
      )
      .join('\n');
    return `**${title}:**\n\n${rows}`;
  };
  return [
    block('V2 gana full@10 sobre V1', 'V2', 'gain'),
    block('V2 pierde full@10 frente a V1', 'V2', 'loss'),
    block('V2n gana full@10 sobre V1', 'V2n', 'gain'),
    block('V3 gana full@10 sobre V1', 'V3', 'gain'),
    block('V3 pierde full@10 frente a V1', 'V3', 'loss'),
  ].join('\n\n');
}

function verdict(
  effect: EffectReport,
  reports: readonly VariantReport[]
): { bucket: string; rationale: string } {
  const d = effect.overall;
  const base = reports.find(report => report.id === effect.baseline)!;
  const target = reports.find(report => report.id === effect.variant)!;
  const tokenRatio =
    base.overall.context_tokens_at_k && target.overall.context_tokens_at_k
      ? target.overall.context_tokens_at_k / base.overall.context_tokens_at_k
      : null;
  const improves = (d.full_evidence_at_k_pp ?? 0) > 0 || (d.hit_at_k_pp ?? 0) > 0;
  const regresses = (d.full_evidence_at_k_pp ?? 0) < 0 || (d.hit_at_k_pp ?? 0) < 0;
  if (!improves && !regresses) {
    return {
      bucket: 'no recomendado (sin efecto medido)',
      rationale: 'No cambia las métricas de recuperación; no justifica complejidad.',
    };
  }
  if (improves && !regresses && (tokenRatio === null || tokenRatio <= 1.1)) {
    return {
      bucket: 'quick win',
      rationale: `Mejora hit/full sin empeorar el otro eje y sin inflar tokens (×${tokenRatio?.toFixed(2) ?? 'n/a'}).`,
    };
  }
  if (improves && (tokenRatio ?? 1) > 2) {
    return {
      bucket: 'prometedor sólo como resumen complementario',
      rationale: `Gana recall pero multiplica tokens ×${tokenRatio?.toFixed(1)} y reduce referenciabilidad; no reemplaza la memoria atómica.`,
    };
  }
  if (improves) {
    return {
      bucket: 'candidato prometedor',
      rationale: 'Gana en un eje con costo acotado; validar en otra conversación antes de adoptar.',
    };
  }
  return {
    bucket: 'no recomendado',
    rationale: 'Empeora hit/full o no compensa el costo; no adoptar como reemplazo.',
  };
}

export function renderReport(results: ResultsFile): string {
  const reports = results.variants;
  const get = (id: RepresentationId): VariantReport => reports.find(report => report.id === id)!;
  const effects = results.effects;
  const nameEffect = effects.find(effect => effect.id === 'name')!;
  const tagEffect = effects.find(effect => effect.id === 'tags')!;
  const combined = effects.find(effect => effect.id === 'combined')!;
  const grouping = effects.find(effect => effect.id === 'grouping')!;
  const v2Verdict = verdict(combined, reports);
  const v2nVerdict = verdict(nameEffect, reports);
  const v3Verdict = verdict(grouping, reports);
  const tagIdentical =
    Math.abs(tagEffect.overall.hit_at_k_pp ?? 0) === 0 &&
    Math.abs(tagEffect.overall.full_evidence_at_k_pp ?? 0) === 0 &&
    Math.abs(tagEffect.overall.mrr_delta ?? 0) === 0;
  const gate = results.gate;

  return `# Experimento B — representación de escritura (V1/V2/V2n/V3)

**Feature:** \`00009-memory-recall-investigation\` · **Tarea:** E-B
**Conversación:** \`${String(results.meta.conversation)}\` · **RAG:** off · **DBs:** SQLite temporales frescas (nunca la DB viva) · **Costo:** $0, sin LLM.

> Gold se usa **solo** para puntuar y mapear evidencia; la ingesta y las queries
> no lo usan. Las cuatro variantes comparten exactamente los mismos 120 probes.

## 1. Método y semántica de matching

| Variante | Definición |
| --- | --- |
${REPRESENTATIONS.map(representation => `| ${representation.id} | ${representation.description} |`).join('\n')}

- **Ingesta determinista** con el CLI del worktree v10 (\`mind create/add\`, tier 3,
  RAG off), una DB nueva por variante y verificación del set de nombres.
- **V1/V2/V2n:** evidencia mapeada por turno. V1 usa el nombre (\`dia_id\`); V2 usa
  el tag \`dia:<dia_id>\`; V2n usa el registro \`name→diaId\` construido en la
  ingesta (no se adivina desde el nombre).
- **V3 (cambio semántico declarado):** un ítem de evidencia cuenta como
  recuperado si una memoria de sesión recuperada **contiene** \`[<dia_id>]\`.
  \`P@10\` en V3 = fracción de memorias devueltas que contienen al menos un ítem
  de evidencia (no puede compararse 1:1 con la pureza por turno).
- **V2 name format:** \`s<sesión>-d<diaSesión>-<speaker>[-<otro>]-<turno>\`,
  todo slug minúscula, p. ej. \`D17:10\` dicho por Melanie a Caroline en la sesión
  17 → \`s17-d17-melanie-caroline-10\`. Sin temas, sentimiento ni relaciones
  inventadas; sólo sesión, dia_id, hablante, interlocutor determinable y turno.
- **V2 tags:** \`[locomo, session:<n>, speaker:<lowercase>, dia:<dia_id>]\`.
  **V2n** = nombres descriptivos + tags originales (separa nombre de tags).

## 2. Gate V1 == baseline congelado

[MEDIDO] **Hallazgo de contenido:** la DB congelada del benchmark se ingirió
**sin** los captions de foto (\`[Photo: ...]\`). Ejemplo medido: \`D8:2\` en la DB
original no contiene caption; la ingesta actual (\`conversationTurns\`) sí la
agrega. Eso cambia tokens, BM25 y ranking: una V1 fresca con captions **no**
reproduce el baseline (full@10 ${fmt(get('V1').overall.full_evidence_at_k)} /
funnel 44/9/37/2 / 67 ítems top-10, frente a 0.456 / 41/10/39/2 / 65
congelados). Por eso el gate se corre sobre una
**calibración de contenido congelado** (V1F: misma representación V1, captions
de foto removidos para igualar la DB histórica). Las variantes V1/V2/V2n/V3 del
resto del experimento usan el contenido actual **con** captions, de forma
consistente entre ellas.

| Chequeo (V1F) | Medido | Congelado | Resultado |
| --- | ---: | ---: | --- |
| Top-10 idéntico al dump instrumentado | ${gate.top10_vs_dump.compared - gate.top10_vs_dump.mismatches}/${gate.top10_vs_dump.compared} | 120/120 | **${gate.top10_vs_dump.match ? 'pass' : 'FAIL'}** |
| Funnel answerable K=10 | ${JSON.stringify(gate.funnel)} | ${JSON.stringify(gate.funnel_expected)} | **${gate.funnel_match ? 'pass' : 'FAIL'}** |
| Ítems evidencia en top-10 | ${gate.item_labels.admitted_top10} | ${gate.frozen_item_labels.admitted_top10} | **${gate.item_labels.admitted_top10 === gate.frozen_item_labels.admitted_top10 ? 'pass' : 'FAIL'}** |
| Ítems admitidos fuera del top-10 | ${gate.item_labels.admitted_outside_top10} | ${gate.frozen_item_labels.admitted_outside_top10} | **${gate.item_labels.admitted_outside_top10 === gate.frozen_item_labels.admitted_outside_top10 ? 'pass' : 'FAIL'}** |
| Ítems ausentes del ranking | ${gate.item_labels.absent_from_ranking} | ${gate.frozen_item_labels.dropped_by_admission + gate.frozen_item_labels.never_candidate} (28 dropped + 35 never) | **${gate.absent_matches_frozen_split ? 'pass' : 'FAIL'}** |

El split \`dropped_by_admission=28\` / \`never_candidate=35\` requiere el dump de
canales instrumentado; la respuesta pública sólo permite medir "ausente del
ranking" (${gate.item_labels.absent_from_ranking}). Al ser el top-10 idéntico
al dump congelado en los 120 probes, el split congelado aplica sin cambios.

> **Implicancia:** el gate valida la representación y el replay, no la
> reproducibilidad de la DB histórica desde el dataset actual. Cualquier
> comparación con el reporte 00008 debe declarar esta diferencia de contenido.

## 3. Métricas globales (answerable, K=10 primario)

[MEDIDO] ${String(results.meta.answerable)} probes answerable (2 sin evidencia gold).
\`full@10\` exige **toda** la evidencia en top-10; en V3 se evalúa por contención
de turno dentro de la memoria de sesión.

${overallTable(reports)}

### K=25 (secundario)

${secondaryTable(reports)}

## 4. Por categoría (K=10)

[MEDIDO]

${categoryTables(reports)}

### Adversarial (proxy, K=10)

[MEDIDO] Sin LLM no se mide rechazo/FP real; se reporta recuperación de la
premisa como proxy.

| Variante | probes | #res medio | 0-res | recall premisa@10 |
| --- | ---: | ---: | ---: | ---: |
${reports
  .map(report => {
    const m = report.adversarial;
    return `| ${report.id} | ${m.probes} | ${fmt(m.mean_results, 1)} | ${m.zero_result_count} | ${fmt(m.evidence_recall_at_k)} |`;
  })
  .join('\n')}

## 5. Efectos separados

[MEDIDO] Cada delta resta su propio baseline (K=10, answerable).

${effectsTable(effects)}

**Lectura:**

- **Efecto nombre (V2n − V1):** ${pp(nameEffect.overall.full_evidence_at_k_pp)} full@10,
  ${pp(nameEffect.overall.hit_at_k_pp)} hit@10. Los tokens descriptivos no
  inventados no mejoran la recuperación: full@10 no cambia y se pierde 1 hit
  (ranking ligeramente movido), con +4 tokens de contexto.
- **Efecto tags (V2 − V2n):** ${pp(tagEffect.overall.full_evidence_at_k_pp)} full@10,
  ${pp(tagEffect.overall.hit_at_k_pp)} hit@10. ${tagIdentical ? 'Ranking idéntico: los tags **no participan del ranking léxico**; sirven para filtrado/organización, no para recall. Es un resultado nulo medido, no un supuesto.' : 'Los tags mueven el ranking en algunos probes.'}
- **Efecto combinado (V2 − V1):** ${pp(combined.overall.full_evidence_at_k_pp)} full@10,
  ${pp(combined.overall.hit_at_k_pp)} hit@10. Todo el efecto de V2 es el del
  nombre; los tags no aportan ni restan al ranking.
- **Efecto agrupación/volumen (V3 − V1):** ${pp(grouping.overall.full_evidence_at_k_pp)} full@10,
  ${pp(grouping.overall.hit_at_k_pp)} hit@10; contexto ${abs(grouping.overall.context_tokens_delta, 0)} tokens y
  ${abs(grouping.overall.mean_results_delta, 1)} resultados medios.
  **Confound de volumen:** V3 tiene 19 memorias en total, así que un top-10 de
  sesiones cubre más de la mitad del corpus; parte del salto es "traer más
  texto", no una mejor señal de ranking. No es comparable 1:1 con un top-10
  sobre 419 turnos.

### Efectos por categoría

${effects
  .map(effect => {
    const rows = Object.entries(effect.by_category)
      .map(
        ([category, delta]) =>
          `| ${category} | ${pp(delta.hit_at_k_pp)} | ${pp(delta.full_evidence_at_k_pp)} | ${abs(delta.mrr_delta)} | ${int(delta.context_tokens_delta)} |`
      )
      .join('\n');
    return `#### ${effect.id} (${effect.variant} − ${effect.baseline})\n\n| Categoría | Δhit@10 | Δfull@10 | ΔMRR | Δtok@10 |\n| --- | ---: | ---: | ---: | ---: |\n${rows}`;
  })
  .join('\n\n')}

## 6. Ejemplos

[MEDIDO] Primer rank de evidencia por probe (\`fuera top-10\` = no recuperada en
ese top-10; el ejemplo usa la pasada primaria). No se muestran contenidos
completos; las preguntas son públicas de LoCoMo.

${examplesBlock(reports)}

## 7. Trade-offs medidos

- **Granularidad vs contexto:** V1/V2/V2n almacenan ${get('V1').memory_count} memorias y
  devuelven ~${fmt(get('V1').overall.context_tokens_at_k, 0)} tokens@10; V3 almacena
  ${get('V3').memory_count} memorias y devuelve ~${fmt(get('V3').overall.context_tokens_at_k, 0)}
  tokens@10 (×${(get('V3').overall.context_tokens_at_k! / get('V1').overall.context_tokens_at_k!).toFixed(2)}).
- **Almacenamiento:** ${int(get('V1').db.total_bytes / 1024, 1)} KB (V1) vs
  ${int(get('V3').db.total_bytes / 1024, 1)} KB (V3): agrupar **aumenta** el
  tamaño (~${(get('V3').db.total_bytes / get('V1').db.total_bytes).toFixed(1)}×)
  porque los documentos largos generan más estructura FTS (trigram/docsize), no
  menos; el texto es el mismo.
- **Referenciabilidad:** V1/V2 permiten citar un turno exacto (\`dia_id\`); V3 obliga
  a citar una sesión y localizar el turno dentro del contenido, lo que complica
  auditoría y "leer sólo lo necesario".
- **Multi-hop:** V3 contiene dos evidencias en una sola memoria cuando caen en la
  misma sesión (ventaja medida: full@10 pasa de 0 a 0.529 en multi-hop), pero el
  precio es ~6.9k tokens@10 en esa categoría.
- **Ranking:** V3 cambia el ranking sobre documentos largos (algunos probes
  pierden full@10); el efecto neto observado está dominado por el volumen de
  texto recuperado, no por una señal léxica superior.
- **Volumen como confound:** con 19 sesiones, un top-10 de V3 devuelve más de la
  mitad de la conversación. En un proyecto real con cientos de sesiones, la
  cobertura de un top-10 de sesiones será mucho menor; el resultado de V3 **no**
  se extrapola sin medir ese régimen.

## 8. Lectura estratégica para memorias reales de agentes

Lo que transfiere (y lo que no), a partir de lo medido:

1. **Memoria atómica con procedencia explícita** (V1/V2) es la mejor base para
   decisiones, bugs/fixes, preferencias, constraints y hechos: permite citar y
   leer exactamente lo recuperado. V3 no reemplaza esa granularidad.
2. **Metadatos no inventados en el nombre** (sesión, hablante, interlocutor,
   turno) son baratos y trazables, pero **no mejoran el recall medido** (full@10
   igual; −1.1pp hit). Su valor es humano/organizativo y de procedencia, no un
   boost de búsqueda.
3. **Tags de procedencia** (\`session:\`, \`speaker:\`, \`dia:\`) no mejoran el
   ranking léxico por sí mismos (efecto nulo medido aquí), pero son la base para
   filtros deterministas y para mapear evidencia sin adivinar. No confundir
   "tag útil para filtrar" con "tag que mejora búsqueda".
4. **Agrupar por sesión** sólo tiene sentido como **memoria resumen
   complementaria** (continuidad, multi-hop). Como sustituto del turno atómico
   multiplica tokens (×14.6), agranda la DB (×3.2) y reduce referenciabilidad; el
   aparente salto de recall está confundido por devolver >50% del corpus en 10
   memorias.
5. **Nada de temas, sentimiento ni relaciones inventadas:** este experimento no
   los usa y no hay evidencia de que aporten; añadirlos exigiría un LLM y
   introduciría riesgo de alucinación.

## 9. Recomendación por variante

- **V1 (actual):** mantener como representación canónica. Es la referencia de precisión y referenciabilidad.
- **V2:** **${v2Verdict.bucket}** para recall. ${v2Verdict.rationale} Los tags de procedencia pueden conservarse por filtrado/trazabilidad aunque no cambien el ranking.
- **V2n (nombre descriptivo solo):** **${v2nVerdict.bucket}** para recall. ${v2nVerdict.rationale} Útil como conveniencia de nombres, no como mejora de búsqueda.
- **V3 (sesión):** **${v3Verdict.bucket}**. ${v3Verdict.rationale} El confound de volumen (19 memorias, top-10 >50% del corpus) impide leer el salto como mejora pura de ranking.

## 10. UNKNOWN

- Una sola conversación (conv-26); no se generaliza sin validar en otra.
- Sin LLM no se mide si el agente **usa** mejor o peor la evidencia recuperada,
  ni alucinación/abstención; sólo retrieval.
- El split exacto \`dropped_by_admission\` vs \`never_candidate\` de V1 se toma del
  dump congelado, no se re-instrumenta aquí.
- El efecto de nombres descriptivos depende del tokenizador/ranking de esta
  versión de Mind; no se extrapola a otros motores.
- V3 con sesiones muy largas puede superar límites prácticos de contexto del
  agente; el costo medido es sólo el de los resultados devueltos.
- El salto de V3 está confundido por volumen (19 memorias; top-10 >50% del
  corpus) y por matching chunk-level; no se interpreta como mejora pura de
  ranking ni se extrapola a un proyecto con muchas sesiones.
- La DB congelada del benchmark no contiene captions de foto; el dataset actual
  sí. El gate se calibró a la convención congelada y las variantes usan el
  contenido actual, así que las métricas de V1 no son directamente comparables
  con el reporte 00008 sin declarar esa diferencia.

## 11. Siguiente experimento (E-C)

Medir top-K (10/20/30), dos consultas enfocadas con presupuesto total 10, y
expansión por vecinos de sesión/turnos cercanos sobre V1, separando "alguna
evidencia" de "TODAS las evidencias" y su costo en tokens. Comando base:

\`\`\`bash
cd benchmarks/agent-memory && bun run experiments/query-strategies/run.ts \\
  --limit 25 --out .work/experiments/e-c
\`\`\`
`;
}

// ── Main ──

export async function runExperiment(
  options: Options
): Promise<{ results: ResultsFile; out: string }> {
  const dataset = JSON.parse(readFileSync(options.locomo, 'utf8')) as Parameters<
    typeof conversationTurns
  >[0];
  const turns: TurnRecord[] = conversationTurns(dataset, options.conversation);
  const participants = loadParticipants(options.locomo, options.conversation);
  const gold = loadGold(options.locomo, options.conversation);
  const probes = readProbes(options.probes);
  const dump = readDumpTop10(options.dump);

  mkdirSync(options.scratch, { recursive: true });
  const reports: VariantReport[] = [];

  const gate = await runGateCalibration(turns, participants, options, probes, gold, dump);
  process.stdout.write(`  V1F gate calibration: ${dump ? 'dump comparison' : 'no dump'}\n`);

  for (const id of ['V1', 'V2', 'V2n', 'V3'] as const) {
    const drafts =
      id === 'V3' ? buildSessionMemories(turns) : buildTurnMemories(turns, id, participants);
    const nameToDia = new Map<string, string>();
    if (id === 'V2n') {
      turns.forEach(turn => {
        const draft = buildTurnMemories([turn], id, participants)[0]!;
        nameToDia.set(draft.name, turn.diaId);
      });
    }
    const report = await runVariant(id, drafts, options, probes, gold, nameToDia);
    reports.push(report);
    process.stdout.write(
      `  ${id}: ${drafts.length} memorias, ingest ${(report.ingest_ms / 1000).toFixed(1)}s\n`
    );
  }

  const effects: EffectReport[] = [
    effectFor('name', 'nombre descriptivo (V2n−V1)', 'V1', 'V2n', reports),
    effectFor('tags', 'tags enriquecidos (V2−V2n)', 'V2n', 'V2', reports),
    effectFor('combined', 'nombre+tags (V2−V1)', 'V1', 'V2', reports),
    effectFor('grouping', 'agrupación por sesión (V3−V1)', 'V1', 'V3', reports),
  ];

  const results: ResultsFile = {
    meta: {
      feature: '00009-memory-recall-investigation',
      task: 'E-B',
      generated_at: new Date().toISOString(),
      rag: 'off',
      conversation: options.conversation,
      participants,
      probe_count: probes.length,
      answerable: probes.filter(probe => !probe.adversarial).length,
      adversarial: probes.filter(probe => probe.adversarial).length,
      space: options.space,
      worktree: resolve(options.worktree),
      dataset: resolve(options.locomo),
      probes: resolve(options.probes),
      gold_usage: 'scoring/mapping only; never used for ingestion or queries',
      k_primary: 10,
      k_secondary: 25,
      v3_matching: 'chunk-level containment ([dia_id] inside a retrieved session memory)',
      gate_content: 'V1F calibration: frozen benchmark convention (no [Photo] captions)',
      variants_content: 'current conversationTurns content (includes [Photo] captions)',
    },
    gate,
    variants: reports,
    effects,
  };

  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(options.out, 'report.md'), renderReport(results));
  return { results, out: options.out };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const { results, out } = await runExperiment(options);
  const v1 = results.variants.find(report => report.id === 'V1')!;
  process.stdout.write(
    `representations done: V1 gate=${results.gate.top10_vs_dump.match && results.gate.funnel_match ? 'pass' : 'FAIL'}, ` +
      `determinism=${results.variants.every(report => report.determinism.identical)}, ` +
      `V1 full@10=${fmt(v1.overall.full_evidence_at_k)} → ${resolve(out)}\n`
  );
  const healthy =
    results.gate.top10_vs_dump.match &&
    results.gate.funnel_match &&
    results.variants.every(report => report.determinism.identical);
  if (!healthy) process.exitCode = 1;
}
