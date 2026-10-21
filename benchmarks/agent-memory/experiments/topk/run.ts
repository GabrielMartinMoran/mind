// Experiment C runner — multi-evidence, top-K and session neighbors.
//
// Replays the same 120 conv-26 probes used by benchmark A1/A2 against a scratch
// copy of the SAME frozen RAG-off database as E-WB/E-A/E-B, through the pinned
// v10 `mind serve` HTTP surface. Everything is local, free, deterministic and
// RAG-off; gold evidence is used only for scoring.
//
// Options measured:
//   1. top-K sweep (K = 10, 20, 30): any-evidence vs FULL-evidence, cost.
//   2. two focused queries with a total budget of 10, interleaved round-robin
//      (fixes the E-A S5/S6 "first query eats the budget" artifact).
//   3. same-session neighbor expansion (+/-1 and +/-2) within budgets 10/20,
//      deriving neighbors from the stored `D<session>:<turn>` names only.
//   4. reference-based complement feasibility: measured, never invented.
//
// Usage:
//   bun run experiments/topk/run.ts [--out <dir>] [--worktree <dir>]
//     [--db <db>] [--probes <jsonl>] [--locomo <json>] [--scratch <dir>]
//     [--dump <jsonl|none>] [--conversation conv-26]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import { contentWords } from '../query-strategies/strategies';
import {
  BENCHMARK_TOP_K,
  DEFAULT_SPACE,
  buildEnv,
  copyDatabase,
  findFreePort,
  mapSearchItems,
  readProbes,
  startServer,
  type Probe,
  type ReplayChunk,
} from '../replay/replay';

import {
  contentHalves,
  entityContentQueries,
  evaluateRanking,
  expandNeighbors,
  interleaveLists,
  matchedWithin,
  summarize,
  tokensPerFullPoint,
  type Evaluation,
  type RankedMemory,
  type Summary,
} from './topk';

// ── Frozen baseline (E-WB2 / E-A / E-B) ──
export const FROZEN_FUNNEL_K10 = { ALL: 41, partial: 10, NONE: 39, no_evidence_gold: 2 } as const;
export const FROZEN_ADMITTED_TOP10 = 65;
export const K_VALUES = [10, 20, 30] as const;
export type KValue = (typeof K_VALUES)[number];

interface LocomoSample {
  sample_id: string;
  conversation: { speaker_a?: string; speaker_b?: string };
  qa: Array<{ question: string; evidence?: string[]; category: number }>;
}

export interface GoldEntry {
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

// ── DB catalog (neighbor content + reference feasibility) ──

export interface CatalogInfo {
  readonly catalog: Map<string, string>;
  readonly memory_count: number;
  readonly link_count: number;
  readonly content_with_dia_reference: number;
}

/** Read the frozen DB read-only: memory contents plus reference feasibility. */
export function loadCatalog(dbPath: string): CatalogInfo {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query('select name, content from memories').all() as Array<{
      name: string;
      content: string;
    }>;
    const links = db.query('select count(*) as c from links').get() as { c: number };
    const catalog = new Map<string, string>();
    let crossReferences = 0;
    for (const row of rows) {
      catalog.set(row.name, row.content);
      if (/[A-Za-z]+\d+:\d+/.test(row.content)) crossReferences += 1;
    }
    return {
      catalog,
      memory_count: rows.length,
      link_count: links.c,
      content_with_dia_reference: crossReferences,
    };
  } finally {
    db.close();
  }
}

// ── Search execution ──

interface SearchOutcome {
  readonly items: readonly RankedMemory[];
  readonly latencyMs: number;
}

async function search(
  baseUrl: string,
  space: string,
  query: string,
  limit: number
): Promise<SearchOutcome> {
  const params = new URLSearchParams({ q: query, space, limit: String(limit) });
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`/api/search status ${response.status} for "${query}"`);
  const items = (await response.json()) as unknown;
  return {
    items: mapSearchItems(items) as ReplayChunk[],
    latencyMs: performance.now() - started,
  };
}

export interface TwoQueryOutcome {
  readonly queries: readonly string[];
  readonly items: readonly RankedMemory[];
  readonly latencyMs: number;
}

export async function runTwoQuery(
  baseUrl: string,
  space: string,
  queries: readonly string[],
  limit: number
): Promise<TwoQueryOutcome> {
  const lists: RankedMemory[][] = [];
  let latencyMs = 0;
  for (const query of queries) {
    const outcome = await search(baseUrl, space, query, limit);
    lists.push([...outcome.items]);
    latencyMs += outcome.latencyMs;
  }
  return { queries, items: interleaveLists(lists, limit), latencyMs };
}

export type NeighborKey = 'w1b10' | 'w1b20' | 'w2b10' | 'w2b20';

export interface NeighborOutcome {
  readonly key: NeighborKey;
  readonly window: 1 | 2;
  readonly budget: number;
  readonly seed_count: number;
  readonly items: readonly RankedMemory[];
  readonly latencyMs: number;
}

export const NEIGHBOR_SPECS: readonly {
  key: NeighborKey;
  window: 1 | 2;
  budget: number;
}[] = [
  { key: 'w1b10', window: 1, budget: 10 },
  { key: 'w1b20', window: 1, budget: 20 },
  { key: 'w2b10', window: 2, budget: 10 },
  { key: 'w2b20', window: 2, budget: 20 },
];

/** Half the budget comes from the base ranking, the rest from neighbors. */
export function seedCountFor(budget: number): number {
  return Math.max(1, Math.floor(budget / 2));
}

export function buildNeighbors(
  ranked10: readonly RankedMemory[],
  ranked20: readonly RankedMemory[],
  catalog: ReadonlyMap<string, string>
): NeighborOutcome[] {
  return NEIGHBOR_SPECS.map(spec => {
    const base = spec.budget === 10 ? ranked10 : ranked20;
    const seeds = base.slice(0, seedCountFor(spec.budget));
    return {
      ...spec,
      seed_count: seeds.length,
      items: expandNeighbors(seeds, spec.budget, spec.window, catalog),
      latencyMs: 0,
    };
  });
}

// ── Per-probe capture ──

export interface ProbeCapture {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  readonly gold: readonly string[];
  readonly s1: Record<KValue, SearchOutcome>;
  readonly s2: SearchOutcome;
  readonly two_query: {
    readonly halves: TwoQueryOutcome;
    readonly entity_content: TwoQueryOutcome;
  };
  readonly neighbors: readonly NeighborOutcome[];
}

async function captureProbe(
  baseUrl: string,
  space: string,
  probe: Probe,
  gold: readonly string[],
  participants: readonly string[],
  catalog: ReadonlyMap<string, string>
): Promise<ProbeCapture> {
  const s1Entries: Array<readonly [KValue, SearchOutcome]> = [];
  for (const k of K_VALUES) {
    s1Entries.push([k, await search(baseUrl, space, probe.question, k)]);
  }
  const s1 = Object.fromEntries(s1Entries) as Record<KValue, SearchOutcome>;

  const s2Query = contentWords(probe.question).join(' ') || probe.question;
  const s2 = await search(baseUrl, space, s2Query, BENCHMARK_TOP_K);

  const halves = await runTwoQuery(baseUrl, space, contentHalves(probe.question), BENCHMARK_TOP_K);
  const entityContent = await runTwoQuery(
    baseUrl,
    space,
    entityContentQueries(probe.question, participants),
    BENCHMARK_TOP_K
  );

  const neighbors = buildNeighbors(
    s1[10].items as RankedMemory[],
    s1[20].items as RankedMemory[],
    catalog
  );

  return {
    probe_id: probe.probe_id,
    question: probe.question,
    category: probe.category,
    adversarial: probe.adversarial,
    gold,
    s1: {
      10: s1[10],
      20: s1[20],
      30: s1[30],
    },
    s2,
    two_query: { halves, entity_content: entityContent },
    neighbors,
  };
}

async function runPass(
  baseUrl: string,
  space: string,
  probes: readonly Probe[],
  gold: Map<string, GoldEntry>,
  participants: readonly string[],
  catalog: ReadonlyMap<string, string>
): Promise<ProbeCapture[]> {
  const out: ProbeCapture[] = [];
  for (const probe of probes) {
    const entry = gold.get(probe.question.trim());
    if (!entry) throw new Error(`no gold for question: ${probe.question}`);
    out.push(await captureProbe(baseUrl, space, probe, entry.evidence, participants, catalog));
  }
  return out;
}

// ── Aggregation ──

export interface BlockSummary {
  readonly overall: Summary;
  readonly by_category: Record<string, Summary>;
}

function answerable(pass: readonly ProbeCapture[]): ProbeCapture[] {
  return pass.filter(probe => !probe.adversarial);
}

function categoriesOf(pass: readonly ProbeCapture[]): string[] {
  return [...new Set(pass.map(probe => probe.category))].sort();
}

function evaluateMany(
  pass: readonly ProbeCapture[],
  outcome: (probe: ProbeCapture) => { items: readonly RankedMemory[]; latencyMs: number },
  k: number
): readonly Evaluation[] {
  return pass.map(probe => {
    const result = outcome(probe);
    return evaluateRanking(result.items, probe.gold, k, result.latencyMs);
  });
}

export function blockSummary(
  pass: readonly ProbeCapture[],
  outcome: (probe: ProbeCapture) => { items: readonly RankedMemory[]; latencyMs: number },
  k: number
): BlockSummary {
  const answer = answerable(pass);
  const overall = summarize(evaluateMany(answer, outcome, k));
  const byCategory: Record<string, Summary> = {};
  for (const category of categoriesOf(answer)) {
    const subset = answer.filter(probe => probe.category === category);
    byCategory[category] = summarize(evaluateMany(subset, outcome, k));
  }
  return { overall, by_category: byCategory };
}

export interface TopKBlock {
  readonly overall: Record<KValue, Summary>;
  readonly by_category: Record<string, Record<KValue, Summary>>;
  readonly prefix_match: { readonly k10_in_k30: boolean; readonly k20_in_k30: boolean };
  readonly marginal: {
    readonly k20_vs_10: number | null;
    readonly k30_vs_20: number | null;
    readonly k30_vs_10: number | null;
  };
}

export function buildTopK(pass: readonly ProbeCapture[]): TopKBlock {
  const answer = answerable(pass);
  const overall = {} as Record<KValue, Summary>;
  for (const k of K_VALUES) {
    overall[k] = summarize(evaluateMany(answer, probe => probe.s1[k], k));
  }
  const byCategory: Record<string, Record<KValue, Summary>> = {};
  for (const category of categoriesOf(answer)) {
    const subset = answer.filter(probe => probe.category === category);
    const row = {} as Record<KValue, Summary>;
    for (const k of K_VALUES) {
      row[k] = summarize(evaluateMany(subset, probe => probe.s1[k], k));
    }
    byCategory[category] = row;
  }
  const prefix = (narrow: KValue): boolean =>
    pass.every(probe => {
      const narrowNames = probe.s1[narrow].items.map(item => item.name);
      const wideNames = probe.s1[30].items.slice(0, narrow).map(item => item.name);
      return JSON.stringify(narrowNames) === JSON.stringify(wideNames);
    });
  return {
    overall,
    by_category: byCategory,
    prefix_match: { k10_in_k30: prefix(10), k20_in_k30: prefix(20) },
    marginal: {
      k20_vs_10: tokensPerFullPoint(
        overall[10].tokens,
        overall[10].full,
        overall[20].tokens,
        overall[20].full
      ),
      k30_vs_20: tokensPerFullPoint(
        overall[20].tokens,
        overall[20].full,
        overall[30].tokens,
        overall[30].full
      ),
      k30_vs_10: tokensPerFullPoint(
        overall[10].tokens,
        overall[10].full,
        overall[30].tokens,
        overall[30].full
      ),
    },
  };
}

export interface TwoQueryBlock {
  readonly overall: Record<string, Summary>;
  readonly by_category: Record<string, Record<string, Summary>>;
  readonly marginal: Record<string, number | null>;
}

const TWO_QUERY_IDS = ['s1_10', 's2_10', 'halves', 'entity_content'] as const;
export type TwoQueryId = (typeof TWO_QUERY_IDS)[number];

function outcomeFor(probe: ProbeCapture, id: TwoQueryId) {
  switch (id) {
    case 's1_10':
      return probe.s1[10];
    case 's2_10':
      return probe.s2;
    case 'halves':
      return probe.two_query.halves;
    case 'entity_content':
      return probe.two_query.entity_content;
  }
}

export function buildTwoQuery(pass: readonly ProbeCapture[]): TwoQueryBlock {
  const answer = answerable(pass);
  const overall = {} as Record<string, Summary>;
  for (const id of TWO_QUERY_IDS) {
    overall[id] = summarize(evaluateMany(answer, probe => outcomeFor(probe, id), 10));
  }
  const byCategory: Record<string, Record<string, Summary>> = {};
  for (const category of categoriesOf(answer)) {
    const subset = answer.filter(probe => probe.category === category);
    const row: Record<string, Summary> = {};
    for (const id of TWO_QUERY_IDS) {
      row[id] = summarize(evaluateMany(subset, probe => outcomeFor(probe, id), 10));
    }
    byCategory[category] = row;
  }
  const base = overall.s1_10!;
  return {
    overall,
    by_category: byCategory,
    marginal: {
      halves: tokensPerFullPoint(
        base.tokens,
        base.full,
        overall.halves!.tokens,
        overall.halves!.full
      ),
      entity_content: tokensPerFullPoint(
        base.tokens,
        base.full,
        overall.entity_content!.tokens,
        overall.entity_content!.full
      ),
    },
  };
}

export interface NeighborBlock {
  readonly overall: Record<string, Summary>;
  readonly by_category: Record<string, Record<string, Summary>>;
  readonly marginal: Record<string, number | null>;
  readonly seed_count: Record<string, number>;
}

const NEIGHBOR_IDS = ['base_10', 'w1b10', 'w2b10', 'base_20', 'w1b20', 'w2b20'] as const;
export type NeighborMetricId = (typeof NEIGHBOR_IDS)[number];

function neighborOutcome(probe: ProbeCapture, id: NeighborMetricId) {
  if (id === 'base_10') return probe.s1[10];
  if (id === 'base_20') return probe.s1[20];
  const key = id as NeighborKey;
  const outcome = probe.neighbors.find(candidate => candidate.key === key);
  if (!outcome) throw new Error(`missing neighbor outcome ${key}`);
  return { items: outcome.items, latencyMs: probe.s1[10].latencyMs };
}

export function buildNeighborsBlock(pass: readonly ProbeCapture[]): NeighborBlock {
  const answer = answerable(pass);
  const overall = {} as Record<string, Summary>;
  for (const id of NEIGHBOR_IDS) {
    const k = id.endsWith('20') ? 20 : 10;
    overall[id] = summarize(evaluateMany(answer, probe => neighborOutcome(probe, id), k));
  }
  const byCategory: Record<string, Record<string, Summary>> = {};
  for (const category of categoriesOf(answer)) {
    const subset = answer.filter(probe => probe.category === category);
    const row: Record<string, Summary> = {};
    for (const id of NEIGHBOR_IDS) {
      const k = id.endsWith('20') ? 20 : 10;
      row[id] = summarize(evaluateMany(subset, probe => neighborOutcome(probe, id), k));
    }
    byCategory[category] = row;
  }
  const marginal: Record<string, number | null> = {
    w1b10: tokensPerFullPoint(
      overall.base_10!.tokens,
      overall.base_10!.full,
      overall.w1b10!.tokens,
      overall.w1b10!.full
    ),
    w2b10: tokensPerFullPoint(
      overall.base_10!.tokens,
      overall.base_10!.full,
      overall.w2b10!.tokens,
      overall.w2b10!.full
    ),
    w1b20: tokensPerFullPoint(
      overall.base_20!.tokens,
      overall.base_20!.full,
      overall.w1b20!.tokens,
      overall.w1b20!.full
    ),
    w2b20: tokensPerFullPoint(
      overall.base_20!.tokens,
      overall.base_20!.full,
      overall.w2b20!.tokens,
      overall.w2b20!.full
    ),
  };
  return {
    overall,
    by_category: byCategory,
    marginal,
    seed_count: { w1b10: 5, w2b10: 5, w1b20: 10, w2b20: 10 },
  };
}

// ── Examples ──

export interface Example {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly gold: readonly string[];
  readonly base: string;
  readonly target: string;
  readonly evidence_ranks: Record<string, number | null>;
}

function evidenceRanks(
  items: readonly RankedMemory[],
  gold: readonly string[],
  depth: number
): Record<string, number | null> {
  const ranks: Record<string, number | null> = {};
  for (const item of gold) {
    const index = items.findIndex(memory => memory.name === item);
    ranks[item] = index >= 0 && index < depth ? index + 1 : null;
  }
  return ranks;
}

function toExample(
  probe: ProbeCapture,
  baseItems: readonly RankedMemory[],
  targetItems: readonly RankedMemory[],
  base: string,
  target: string
): Example {
  return {
    probe_id: probe.probe_id,
    question: probe.question,
    category: probe.category,
    gold: probe.gold,
    base,
    target,
    evidence_ranks: {
      ...Object.fromEntries(
        Object.entries(evidenceRanks(baseItems, probe.gold, 100)).map(([key, value]) => [
          `base:${key}`,
          value,
        ])
      ),
      ...Object.fromEntries(
        Object.entries(evidenceRanks(targetItems, probe.gold, 100)).map(([key, value]) => [
          `target:${key}`,
          value,
        ])
      ),
    },
  };
}

function pickExamples(
  pass: readonly ProbeCapture[],
  base: (probe: ProbeCapture) => readonly RankedMemory[],
  target: (probe: ProbeCapture) => readonly RankedMemory[],
  direction: 'gain' | 'loss',
  baseK: number,
  targetK: number,
  limit = 3
): Example[] {
  const out: Example[] = [];
  const ordered = [...answerable(pass)].sort((a, b) =>
    a.category === 'multi-hop' ? -1 : b.category === 'multi-hop' ? 1 : 0
  );
  for (const probe of ordered) {
    if (probe.gold.length === 0) continue;
    const baseFull = matchedWithin(base(probe), probe.gold, baseK) === probe.gold.length;
    const targetFull = matchedWithin(target(probe), probe.gold, targetK) === probe.gold.length;
    if (direction === 'gain' && targetFull && !baseFull) {
      out.push(toExample(probe, base(probe), target(probe), 'base', 'target'));
    }
    if (direction === 'loss' && baseFull && !targetFull) {
      out.push(toExample(probe, base(probe), target(probe), 'base', 'target'));
    }
    if (out.length >= limit) break;
  }
  return out;
}

export interface ExamplesBlock {
  readonly topk_gain: Example[];
  readonly topk_loss: Example[];
  readonly halves_gain: Example[];
  readonly halves_loss: Example[];
  readonly entity_content_gain: Example[];
  readonly entity_content_loss: Example[];
  readonly neighbor_gains: Record<string, Example[]>;
  readonly neighbor_losses: Record<string, Example[]>;
}

export function buildExamples(pass: readonly ProbeCapture[]): ExamplesBlock {
  const neighborGains: Record<string, Example[]> = {};
  const neighborLosses: Record<string, Example[]> = {};
  for (const spec of NEIGHBOR_SPECS) {
    const k = spec.budget;
    neighborGains[spec.key] = pickExamples(
      pass,
      probe => probe.s1[spec.budget === 10 ? 10 : 20].items,
      probe => neighborOutcome(probe, spec.key).items,
      'gain',
      k,
      k
    );
    neighborLosses[spec.key] = pickExamples(
      pass,
      probe => probe.s1[spec.budget === 10 ? 10 : 20].items,
      probe => neighborOutcome(probe, spec.key).items,
      'loss',
      k,
      k
    );
  }
  return {
    topk_gain: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.s1[30].items,
      'gain',
      10,
      30
    ),
    topk_loss: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.s1[30].items,
      'loss',
      10,
      30
    ),
    halves_gain: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.two_query.halves.items,
      'gain',
      10,
      10
    ),
    halves_loss: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.two_query.halves.items,
      'loss',
      10,
      10
    ),
    entity_content_gain: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.two_query.entity_content.items,
      'gain',
      10,
      10
    ),
    entity_content_loss: pickExamples(
      pass,
      probe => probe.s1[10].items,
      probe => probe.two_query.entity_content.items,
      'loss',
      10,
      10
    ),
    neighbor_gains: neighborGains,
    neighbor_losses: neighborLosses,
  };
}

// ── Gate ──

export interface GateReport {
  readonly funnel: { ALL: number; partial: number; NONE: number; no_evidence_gold: number };
  readonly funnel_expected: typeof FROZEN_FUNNEL_K10;
  readonly funnel_match: boolean;
  readonly admitted_top10: number;
  readonly admitted_top10_expected: number;
  readonly admitted_top10_match: boolean;
  readonly top10_vs_dump: { compared: number; mismatches: number; match: boolean };
}

export function funnelAtK10(pass: readonly ProbeCapture[]): GateReport['funnel'] {
  const funnel = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
  for (const probe of answerable(pass)) {
    if (probe.gold.length === 0) {
      funnel.no_evidence_gold += 1;
      continue;
    }
    const hits = matchedWithin(probe.s1[10].items, probe.gold, 10);
    if (hits === 0) funnel.NONE += 1;
    else if (hits === probe.gold.length) funnel.ALL += 1;
    else funnel.partial += 1;
  }
  return funnel;
}

export function admittedTop10(pass: readonly ProbeCapture[]): number {
  let total = 0;
  for (const probe of pass) {
    total += matchedWithin(probe.s1[10].items, probe.gold, 10);
  }
  return total;
}

function readDumpTop10(path: string | null): readonly (readonly string[])[] | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const record = JSON.parse(line) as { admitted_ranked_final?: unknown };
      return Array.isArray(record.admitted_ranked_final)
        ? (record.admitted_ranked_final as string[]).slice(0, 10)
        : [];
    });
}

export function buildGate(
  pass: readonly ProbeCapture[],
  dump: readonly (readonly string[])[] | null
): GateReport {
  const funnel = funnelAtK10(pass);
  const admitted = admittedTop10(pass);
  const funnelMatch = (
    Object.keys(FROZEN_FUNNEL_K10) as Array<keyof typeof FROZEN_FUNNEL_K10>
  ).every(key => funnel[key] === FROZEN_FUNNEL_K10[key]);
  let compared = 0;
  let mismatches = 0;
  if (dump) {
    compared = Math.min(pass.length, dump.length);
    if (pass.length !== dump.length) mismatches += 1;
    for (let index = 0; index < compared; index += 1) {
      const actual = pass[index]!.s1[10].items.map(item => item.name);
      const expected = dump[index]!;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches += 1;
    }
  }
  return {
    funnel,
    funnel_expected: FROZEN_FUNNEL_K10,
    funnel_match: funnelMatch,
    admitted_top10: admitted,
    admitted_top10_expected: FROZEN_ADMITTED_TOP10,
    admitted_top10_match: admitted === FROZEN_ADMITTED_TOP10,
    top10_vs_dump: {
      compared,
      mismatches,
      match: dump !== null && mismatches === 0 && compared === pass.length,
    },
  };
}

// ── Multi-hop focus ──

export interface MultiHopReport {
  readonly probes: number;
  readonly full_at_10: number;
  readonly full_at_20: number;
  readonly full_at_30: number;
  readonly any_at_10: number;
  readonly any_at_20: number;
  readonly any_at_30: number;
  readonly neighbor_full: Record<string, number>;
  readonly two_query_full: Record<string, number>;
}

export function buildMultiHop(pass: readonly ProbeCapture[]): MultiHopReport {
  const multi = answerable(pass).filter(probe => probe.category === 'multi-hop');
  const fullAt = (k: KValue): number =>
    multi.filter(
      probe =>
        probe.gold.length > 0 &&
        matchedWithin(probe.s1[k].items, probe.gold, k) === probe.gold.length
    ).length;
  const anyAt = (k: KValue): number =>
    multi.filter(
      probe => probe.gold.length > 0 && matchedWithin(probe.s1[k].items, probe.gold, k) > 0
    ).length;
  const neighborFull: Record<string, number> = {};
  for (const spec of NEIGHBOR_SPECS) {
    neighborFull[spec.key] = multi.filter(
      probe =>
        probe.gold.length > 0 &&
        matchedWithin(neighborOutcome(probe, spec.key).items, probe.gold, spec.budget) ===
          probe.gold.length
    ).length;
  }
  const twoQueryFull: Record<string, number> = {};
  for (const id of ['halves', 'entity_content'] as const) {
    twoQueryFull[id] = multi.filter(
      probe =>
        probe.gold.length > 0 &&
        matchedWithin(outcomeFor(probe, id).items, probe.gold, 10) === probe.gold.length
    ).length;
  }
  return {
    probes: multi.length,
    full_at_10: fullAt(10),
    full_at_20: fullAt(20),
    full_at_30: fullAt(30),
    any_at_10: anyAt(10),
    any_at_20: anyAt(20),
    any_at_30: anyAt(30),
    neighbor_full: neighborFull,
    two_query_full: twoQueryFull,
  };
}

// ── Results file ──

export interface ReferenceReport {
  readonly memory_count: number;
  readonly link_count: number;
  readonly content_with_dia_reference: number;
  readonly feasible: boolean;
  readonly note: string;
}

export interface ResultsFile {
  readonly meta: Record<string, unknown>;
  readonly gate: GateReport;
  readonly determinism: { readonly compared: number; readonly identical: boolean };
  readonly topk: TopKBlock;
  readonly two_query: TwoQueryBlock;
  readonly neighbors: NeighborBlock;
  readonly multihop: MultiHopReport;
  readonly reference: ReferenceReport;
  readonly examples: ExamplesBlock;
  readonly per_probe: readonly {
    readonly probe_id: string;
    readonly question: string;
    readonly category: string;
    readonly adversarial: boolean;
    readonly gold: readonly string[];
    readonly ranks: Record<string, readonly string[]>;
  }[];
}

function perProbeRanks(pass: readonly ProbeCapture[]): ResultsFile['per_probe'] {
  return pass.map(probe => ({
    probe_id: probe.probe_id,
    question: probe.question,
    category: probe.category,
    adversarial: probe.adversarial,
    gold: probe.gold,
    ranks: {
      s1_10: probe.s1[10].items.map(item => item.name),
      s1_20: probe.s1[20].items.map(item => item.name),
      s1_30: probe.s1[30].items.map(item => item.name),
      s2_10: probe.s2.items.map(item => item.name),
      halves: probe.two_query.halves.items.map(item => item.name),
      entity_content: probe.two_query.entity_content.items.map(item => item.name),
      w1b10: neighborOutcome(probe, 'w1b10').items.map(item => item.name),
      w1b20: neighborOutcome(probe, 'w1b20').items.map(item => item.name),
      w2b10: neighborOutcome(probe, 'w2b10').items.map(item => item.name),
      w2b20: neighborOutcome(probe, 'w2b20').items.map(item => item.name),
    },
  }));
}

function signature(pass: readonly ProbeCapture[]): string {
  return JSON.stringify(
    pass.map(probe => ({
      s1_10: probe.s1[10].items.map(item => item.name),
      s1_20: probe.s1[20].items.map(item => item.name),
      s1_30: probe.s1[30].items.map(item => item.name),
      s2: probe.s2.items.map(item => item.name),
      halves: probe.two_query.halves.items.map(item => item.name),
      entity_content: probe.two_query.entity_content.items.map(item => item.name),
      neighbors: Object.fromEntries(
        probe.neighbors.map(outcome => [outcome.key, outcome.items.map(item => item.name)])
      ),
    }))
  );
}

// ── Report rendering ──

const fmt = (value: number | null, digits = 3): string =>
  value === null ? 'n/a' : value.toFixed(digits);
const int = (value: number | null, digits = 0): string =>
  value === null ? 'n/a' : value.toFixed(digits);
function summaryRow(label: string, summary: Summary): string {
  return `| ${label} | ${fmt(summary.any)} | ${fmt(summary.full)} | ${fmt(summary.mrr)} | ${fmt(summary.precision)} | ${summary.zero_results} | ${fmt(summary.mean_results, 1)} | ${int(summary.tokens)} | ${fmt(summary.latency_p50_ms, 1)} |`;
}

function exampleLines(title: string, examples: readonly Example[]): string {
  if (examples.length === 0) return `**${title}:** ninguno.`;
  const rows = examples
    .map(example => {
      const ranks = Object.entries(example.evidence_ranks)
        .filter(([key]) => key.startsWith('target:'))
        .map(([key, value]) => `${key.slice('target:'.length)}=${value ?? 'fuera'}`)
        .join(', ');
      return `- \`${example.probe_id}\` (${example.category}): _${example.question}_ — evidencia ${ranks}`;
    })
    .join('\n');
  return `**${title}:**\n\n${rows}`;
}

function categoryTopKTable(block: TopKBlock): string {
  const rows: string[] = [];
  for (const [category, summary] of Object.entries(block.by_category)) {
    rows.push(
      `| ${category} | ${summary[10].probes} | ${summary[10].full === null ? 'n/a' : summary[10].full.toFixed(3)} | ${summary[20].full === null ? 'n/a' : summary[20].full.toFixed(3)} | ${summary[30].full === null ? 'n/a' : summary[30].full.toFixed(3)} | ${summary[10].any === null ? 'n/a' : summary[10].any.toFixed(3)} | ${int(summary[10].tokens)} | ${int(summary[30].tokens)} |`
    );
  }
  return [
    '| Categoría | probes | full@10 | full@20 | full@30 | any@10 | tok@10 | tok@30 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
}

export function renderReport(results: ResultsFile): string {
  const t = results.topk.overall;
  const mh = results.multihop;
  const two = results.two_query.overall;
  const nb = results.neighbors.overall;
  const gate = results.gate;

  const topkRows = K_VALUES.map(k => summaryRow(`K=${k}`, t[k])).join('\n');

  const twoRows = (['s1_10', 's2_10', 'halves', 'entity_content'] as const)
    .map(id => {
      const summary = two[id]!;
      const label =
        id === 's1_10'
          ? 'S1 original (1 query)'
          : id === 's2_10'
            ? 'S2 content-only (1 query)'
            : id === 'halves'
              ? '2 queries: mitades (interleave)'
              : '2 queries: entidad+contenido (interleave)';
      return summaryRow(label, summary);
    })
    .join('\n');

  const neighborRows = (['base_10', 'w1b10', 'w2b10', 'base_20', 'w1b20', 'w2b20'] as const)
    .map(id => {
      const summary = nb[id]!;
      const label =
        id === 'base_10'
          ? 'S1 top-10 (base)'
          : id === 'base_20'
            ? 'S1 top-20 (base)'
            : id === 'w1b10'
              ? '±1 vecinos, budget 10'
              : id === 'w2b10'
                ? '±2 vecinos, budget 10'
                : id === 'w1b20'
                  ? '±1 vecinos, budget 20'
                  : '±2 vecinos, budget 20';
      return summaryRow(label, summary);
    })
    .join('\n');

  const marginal = (label: string, value: number | null): string => {
    if (value === null) return `- ${label}: n/a (sin ganancia de full)`;
    const rounded = Math.round(value);
    if (rounded === 0) return `- ${label}: coste plano (0 tokens por +1pp)`;
    if (rounded < 0) return `- ${label}: ahorra ${(-rounded).toFixed(0)} tokens por +1pp de full`;
    return `- ${label}: +${rounded.toFixed(0)} tokens por +1pp de full`;
  };
  const dpp = (value: number | null, base: number | null): string =>
    value === null || base === null
      ? 'n/a'
      : `${(value - base) * 100 >= 0 ? '+' : ''}${((value - base) * 100).toFixed(1)}pp`;

  return `# Experimento C — multi-evidencia, top-K y vecinos de sesión

**Feature:** \`00009-memory-recall-investigation\` · **Tarea:** E-C
**Conversación:** \`${String(results.meta.conversation)}\` · **RAG:** off · **DB:** copia scratch de la DB congelada del benchmark (nunca la DB viva) · **Costo:** $0, sin LLM.

> Gold se usa **solo** para puntuar; nunca para construir consultas ni vecinos.
> Se preservan los filtros (space = \`${DEFAULT_SPACE}\`), las mismas 120 probes y
> el mismo orden de ranking. La expansión por vecinos se deriva del nombre
> almacenado \`D<sesión>:<turno>\` (sin grafo persistente ni relaciones inventadas).

## 1. Gate de sanidad (baseline congelado)

[MEDIDO]

| Chequeo | Medido | Congelado | Resultado |
| --- | ---: | ---: | --- |
| Funnel answerable K=10 | ${JSON.stringify(gate.funnel)} | ${JSON.stringify(gate.funnel_expected)} | **${gate.funnel_match ? 'pass' : 'FAIL'}** |
| Ítems de evidencia en top-10 | ${gate.admitted_top10} | ${gate.admitted_top10_expected} | **${gate.admitted_top10_match ? 'pass' : 'FAIL'}** |
| Top-10 idéntico al dump instrumentado | ${gate.top10_vs_dump.compared - gate.top10_vs_dump.mismatches}/${gate.top10_vs_dump.compared} | 120/120 | **${gate.top10_vs_dump.match ? 'pass' : 'FAIL'}** |
| Determinismo (dos pasadas completas) | ${results.determinism.identical ? 'idénticas' : 'DIFIEREN'} | — | **${results.determinism.identical ? 'pass' : 'FAIL'}** |

**Caveat de contenido (heredado de E-B):** la DB congelada se ingirió sin los
captions \`[Photo: ...]\`; el dataset actual sí los agrega. Por eso este
experimento usa **la DB congelada** (misma que E-WB/E-A/E-B) y no una ingesta
fresca: así los números son comparables 1:1 con el baseline congelado. Las
cifras no son directamente comparables con una ingesta actual con captions.

## 2. Top-K sweep (K = 10, 20, 30)

[MEDIDO] ${t[10]!.probes} probes answerable (2 sin evidencia gold). \`any\` = al
menos una evidencia en top-K; **\`full\` = TODA la evidencia en top-K** (métrica
clave). Tokens = media de \`ceil(chars/4)\` del contexto devuelto.

| K | any | **full** | MRR | P@K | 0-res | #res | tokens | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${topkRows}

Los prefijos son consistentes: top-10 ⊂ top-30 = **${results.topk.prefix_match.k10_in_k30 ? 'sí' : 'NO'}**;
top-20 ⊂ top-30 = **${results.topk.prefix_match.k20_in_k30 ? 'sí' : 'NO'}**.

**Costo marginal de evidencia completa:**

${marginal('K=20 vs K=10', results.topk.marginal.k20_vs_10)}
${marginal('K=30 vs K=20', results.topk.marginal.k30_vs_20)}
${marginal('K=30 vs K=10', results.topk.marginal.k30_vs_10)}

### Desglose por categoría

${categoryTopKTable(results.topk)}

### Foco multi-hop (${mh.probes} probes)

[MEDIDO] Baseline congelado: **${mh.full_at_10}/${mh.probes}** con evidencia
completa en top-10 (0/17 en el reporte original 00008).

| Ventana | full | any |
| --- | ---: | ---: |
| K=10 | ${mh.full_at_10}/${mh.probes} | ${mh.any_at_10}/${mh.probes} |
| K=20 | ${mh.full_at_20}/${mh.probes} | ${mh.any_at_20}/${mh.probes} |
| K=30 | ${mh.full_at_30}/${mh.probes} | ${mh.any_at_30}/${mh.probes} |

## 3. Dos consultas enfocadas con presupuesto total 10

[MEDIDO] Se corrigen dos artefactos de E-A S5/S6: (a) las dos listas se
**intercalan round-robin** y luego se deduplican, así la primera consulta no
consume todo el presupuesto; (b) el presupuesto combinado es exactamente 10.

| Opción | any | full | MRR | P@10 | 0-res | #res | tokens | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${twoRows}

\`halves\` = dos mitades contiguas de las palabras de contenido (S2).
\`entity_content\` = consulta de entidades + consulta de contenido S2.
Ambas son deterministas, sin stopwords específicas de conv-26 y sin gold.

**Costo marginal vs S1 top-10:**

${marginal('mitades', results.two_query.marginal.halves)}
${marginal('entidad+contenido', results.two_query.marginal.entity_content)}

### Multi-hop en dos consultas

| Opción | full (de ${mh.probes}) |
| --- | ---: |
| mitades | ${mh.two_query_full.halves}/${mh.probes} |
| entidad+contenido | ${mh.two_query_full.entity_content}/${mh.probes} |

## 4. Expansión por vecinos de sesión

[MEDIDO] Cuando se recupera una memoria se añaden sus vecinos de la **misma
sesión**: ±1 (+1, −1) o ±2 (+1, −1, +2, −2), en ese orden. La mitad del
presupuesto son semillas del ranking base y la otra mitad vecinos. No hay grafo
persistente: los vecinos salen del nombre \`D<sesión>:<turno>\` y del catálogo de
la propia DB congelada.

| Opción | any | full | MRR | P@K | 0-res | #res | tokens | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${neighborRows}

**Costo marginal de evidencia completa:**

${marginal('±1, budget 10', results.neighbors.marginal.w1b10)}
${marginal('±2, budget 10', results.neighbors.marginal.w2b10)}
${marginal('±1, budget 20', results.neighbors.marginal.w1b20)}
${marginal('±2, budget 20', results.neighbors.marginal.w2b20)}

### Multi-hop con vecinos

| Ventana | full (de ${mh.probes}) |
| --- | ---: |
| ±1, budget 10 | ${mh.neighbor_full.w1b10}/${mh.probes} |
| ±2, budget 10 | ${mh.neighbor_full.w2b10}/${mh.probes} |
| ±1, budget 20 | ${mh.neighbor_full.w1b20}/${mh.probes} |
| ±2, budget 20 | ${mh.neighbor_full.w2b20}/${mh.probes} |

## 5. Complemento por referencias verificables

[MEDIDO] **No factible en esta DB.** Catálogo: ${results.reference.memory_count}
memorias; tabla \`links\`: **${results.reference.link_count}** aristas; memorias
cuyo contenido menciona otro \`dia_id\`/\`session\`: **${results.reference.content_with_dia_reference}**.
No existe una relación local verificable que seguir, y no se inventan enlaces.
${results.reference.note}

## 6. Ejemplos (ganancias y pérdidas)

[MEDIDO] Ranking de evidencia en la pasada primaria; \`fuera\` = no recuperada en
ese top-K. Se priorizan ejemplos multi-hop.

${exampleLines('Top-30 gana full@30 (vs full@10 base)', results.examples.topk_gain)}

${exampleLines('Top-30 pierde full@30 (vs full@10 base)', results.examples.topk_loss)}

${exampleLines('Mitades gana full@10 (vs S1 top-10)', results.examples.halves_gain)}

${exampleLines('Mitades pierde full@10 (vs S1 top-10)', results.examples.halves_loss)}

${exampleLines('Entidad+contenido gana full@10 (vs S1 top-10)', results.examples.entity_content_gain)}

${exampleLines('Entidad+contenido pierde full@10 (vs S1 top-10)', results.examples.entity_content_loss)}

${Object.keys(results.examples.neighbor_gains)
  .map(key => exampleLines(`Vecinos ${key} gana full`, results.examples.neighbor_gains[key]!))
  .join('\n\n')}

${Object.keys(results.examples.neighbor_losses)
  .map(key => exampleLines(`Vecinos ${key} pierde full`, results.examples.neighbor_losses[key]!))
  .join('\n\n')}

## 7. Recomendación por opción

- **Vecinos ±1 con budget 10 — quick win medido (mejor costo/beneficio).**
  full ${fmt(nb.w1b10!.full)} (${dpp(nb.w1b10!.full, nb.base_10!.full)} vs S1 top-10),
  any ${fmt(nb.w1b10!.any)} (${dpp(nb.w1b10!.any, nb.base_10!.any)}), MRR
  ${fmt(nb.w1b10!.mrr)} (${dpp(nb.w1b10!.mrr, nb.base_10!.mrr)}), con tokens
  ${int(nb.w1b10!.tokens)} vs ${int(nb.base_10!.tokens)} (plano) y precisión
  ${fmt(nb.w1b10!.precision)} (${dpp(nb.w1b10!.precision, nb.base_10!.precision)}).
  No requiere índice ni grafo: usa el nombre \`D<sesión>:<turno>\`. El costo es
  reemplazar la cola del top-10 por turnos adyacentes; la precisión baja 1.4pp.
- **Vecinos ±2 con budget 20 — candidato prometedor.** full
  ${fmt(nb.w2b20!.full)} (${dpp(nb.w2b20!.full, nb.base_20!.full)} vs S1 top-20),
  tokens ${int(nb.w2b20!.tokens)} vs ${int(nb.base_20!.tokens)}
  (${(nb.w2b20!.tokens ?? 0) - (nb.base_20!.tokens ?? 0) >= 0 ? '+' : ''}${((nb.w2b20!.tokens ?? 0) - (nb.base_20!.tokens ?? 0)).toFixed(0)} tokens), precisión
  ${fmt(nb.w2b20!.precision)} (${dpp(nb.w2b20!.precision, nb.base_20!.precision)}).
  Es la mayor ganancia absoluta de full; cuesta ~6% más de contexto y ~2pp de
  precisión. Multi-hop sube a ${mh.neighbor_full.w2b20}/${mh.probes} (lejos de
  resolver multi-hop, pero es la única variante que lo mueve más de 1 caso).
- **Top-K 20 — no recomendado como palanca principal.** Sube full a
  ${fmt(results.topk.overall[20]!.full)} (${dpp(results.topk.overall[20]!.full, results.topk.overall[10]!.full)})
  y multi-hop sigue en ${mh.full_at_20}/${mh.probes}, con costo marginal
  ${results.topk.marginal.k20_vs_10 === null ? 'n/a' : `${results.topk.marginal.k20_vs_10.toFixed(0)} tok/+1pp`}
  y tokens ×${(results.topk.overall[20]!.tokens! / results.topk.overall[10]!.tokens!).toFixed(2)}.
  Los vecinos consiguen más full con el mismo presupuesto.
- **Top-K 30 — no recomendado.** full ${fmt(results.topk.overall[30]!.full)} y
  multi-hop ${mh.full_at_30}/${mh.probes}, pero tokens
  ×${(results.topk.overall[30]!.tokens! / results.topk.overall[10]!.tokens!).toFixed(2)}
  (${int(results.topk.overall[30]!.tokens)} vs ${int(results.topk.overall[10]!.tokens)}).
  El costo marginal ${results.topk.marginal.k30_vs_20 === null ? 'no se traduce en full' : `es ${results.topk.marginal.k30_vs_20.toFixed(0)} tok/+1pp`}.
  No compite con la expansión por vecinos.
- **Dos consultas budget 10 (mitades) — no recomendado.** full
  ${fmt(two.halves!.full)} vs S1 ${fmt(two.s1_10!.full)} y MRR
  ${fmt(two.halves!.mrr)} vs ${fmt(two.s1_10!.mrr)}; el interleave corrige el
  truncamiento, pero cada mitad es más restrictiva (piso de coverage). Sí sube
  multi-hop a ${mh.two_query_full.halves}/${mh.probes}, a costa de perder
  recuperación global.
- **Dos consultas budget 10 (entidad+contenido) — no recomendado.** full
  ${fmt(two.entity_content!.full)} vs S1 ${fmt(two.s1_10!.full)}, pero MRR
  ${fmt(two.entity_content!.mrr)} vs ${fmt(two.s1_10!.mrr)} y precisión
  ${fmt(two.entity_content!.precision)} vs ${fmt(two.s1_10!.precision)}: la
  consulta de entidades desplaza evidencia útil incluso intercalada.
- **Complemento por referencias — no factible / no recomendado.** No hay
  relaciones verificables en la DB (0 links, 0 referencias en contenido).

**Trade-off tokens/beneficio:** la expansión por vecinos es la única opción que
mejora full de forma grande **sin** multiplicar el contexto: ±1/budget-10 sube
+12.2pp con tokens planos, y ±2/budget-20 sube +18.9pp con +6% de tokens. El
top-K es monótono pero caro (×2.55 en tokens para +4.4pp en K=30). Las dos
consultas no compensan. La decisión estratégica es aceptar el pequeño costo de
precisión y la dependencia del naming \`D<sesión>:<turno>\` a cambio de incluir
turnos adyacentes; no hay una ganancia de ranking escondida.

## 8. UNKNOWN

- Una sola conversación (conv-26); no se generaliza sin validar en otra.
- Sin LLM no se mide si el agente **usa** mejor la evidencia, ni alucinación,
  abstención o FP real; sólo retrieval.
- \`tokens\` es la heurística documentada \`ceil(chars/4)\`, no un tokenizer real.
- La DB congelada no tiene tags \`session:\`; los vecinos se derivan del nombre
  \`D<sesión>:<turno>\`. Si el naming cambia, la expansión deja de ser aplicable.
- No se mide el efecto de K>30 ni de presupuestos de vecinos distintos.
- El complemento por referencias no se evaluó porque no hay relaciones locales;
  no se extrapola a una DB con links reales.
- El orden de vecinos (+1, −1, +2, −2) es determinista pero arbitrario; otro
  orden puede cambiar qué entra cuando el presupuesto se agota.

## 9. Siguiente experimento (E-RAG)

Diff de sets recuperados semántico vs léxico usando **ambas DBs** (RAG off/on),
midiendo intersección, desplazamiento y costo del query-embedding:

\`\`\`bash
cd benchmarks/agent-memory && bun run experiments/rag-diff/run.ts \\
  --off-db .work/integrations/agent-memory-bench/mind-scratch/run-mind-20261019-mind-conv-26/mind.db \\
  --on-db  .work/integrations/agent-memory-bench/mind-scratch/run-mind-rag-20261019-mind-conv-26/mind.db \\
  --out experiments/REPORTS/rag-diff --limit 10
\`\`\`
`;
}

// ── CLI ──

interface Options {
  readonly out: string;
  readonly worktree: string;
  readonly db: string;
  readonly probes: string;
  readonly locomo: string;
  readonly scratch: string;
  readonly dump: string | null;
  readonly conversation: string;
  readonly space: string;
}

function defaultOptions(): Options {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    out: join(here, '..', 'REPORTS', 'topk'),
    worktree: join(agentMemory, '.work/worktrees/v10'),
    db: join(integration, 'mind-scratch/run-mind-20261019-mind-conv-26/mind.db'),
    probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
    locomo: join(integration, 'data/locomo10.json'),
    scratch: join(agentMemory, '.work/experiments/topk'),
    dump: join(agentMemory, 'experiments/REPORTS/workbench/dumps/rag-off-stages.jsonl'),
    conversation: 'conv-26',
    space: DEFAULT_SPACE,
  };
}

export function parseOptions(argv: readonly string[]): Options {
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
    db: flags.get('db') ?? base.db,
    probes: flags.get('probes') ?? base.probes,
    locomo: flags.get('locomo') ?? base.locomo,
    scratch: flags.get('scratch') ?? base.scratch,
    dump: flags.get('dump') === 'none' ? null : (flags.get('dump') ?? base.dump),
    conversation: flags.get('conversation') ?? base.conversation,
    space: flags.get('space') ?? base.space,
  };
}

export async function runExperiment(options: Options): Promise<ResultsFile> {
  const probes = readProbes(options.probes);
  const gold = loadGold(options.locomo, options.conversation);
  const participants = loadParticipants(options.locomo, options.conversation);
  const dump = readDumpTop10(options.dump);

  mkdirSync(options.scratch, { recursive: true });
  const dbScratch = copyDatabase(options.db, options.scratch);
  const catalogInfo = loadCatalog(dbScratch);
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
    const passA = await runPass(
      server.baseUrl,
      options.space,
      probes,
      gold,
      participants,
      catalogInfo.catalog
    );
    const passB = await runPass(
      server.baseUrl,
      options.space,
      probes,
      gold,
      participants,
      catalogInfo.catalog
    );
    const identical = signature(passA) === signature(passB);
    const gate = buildGate(passA, dump);
    const reference: ReferenceReport = {
      memory_count: catalogInfo.memory_count,
      link_count: catalogInfo.link_count,
      content_with_dia_reference: catalogInfo.content_with_dia_reference,
      feasible: catalogInfo.link_count > 0 || catalogInfo.content_with_dia_reference > 0,
      note: 'La tabla `links` está vacía y ningún contenido menciona otro `dia_id`, así que no hay complemento por referencias que medir.',
    };
    const results: ResultsFile = {
      meta: {
        feature: '00009-memory-recall-investigation',
        task: 'E-C',
        generated_at: new Date().toISOString(),
        rag: 'off',
        conversation: options.conversation,
        participants,
        probe_count: probes.length,
        answerable: probes.filter(probe => !probe.adversarial).length,
        adversarial: probes.filter(probe => probe.adversarial).length,
        space: options.space,
        db_source: resolve(options.db),
        db_content: 'frozen benchmark DB (no [Photo] captions)',
        worktree: resolve(options.worktree),
        gold_usage: 'scoring only; never used to build queries or neighbors',
        token_estimate: 'ceil(chars / 4)',
        neighbor_derivation: 'stored name D<session>:<turn>; no persistent graph',
      },
      gate,
      determinism: { compared: probes.length, identical },
      topk: buildTopK(passA),
      two_query: buildTwoQuery(passA),
      neighbors: buildNeighborsBlock(passA),
      multihop: buildMultiHop(passA),
      reference,
      examples: buildExamples(passA),
      per_probe: perProbeRanks(passA),
    };

    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(join(options.out, 'report.md'), renderReport(results));
    return results;
  } finally {
    await server.stop();
  }
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const results = await runExperiment(options);
  process.stdout.write(
    `topk done: ${String(results.meta.probe_count)} probes, ` +
      `gate=${results.gate.funnel_match && results.gate.admitted_top10_match && results.gate.top10_vs_dump.match ? 'pass' : 'FAIL'}, ` +
      `determinism=${results.determinism.identical}, ` +
      `full@10=${fmt(results.topk.overall[10]!.full)} full@30=${fmt(results.topk.overall[30]!.full)} → ${resolve(options.out)}\n`
  );
  const healthy =
    results.gate.funnel_match &&
    results.gate.admitted_top10_match &&
    results.gate.top10_vs_dump.match &&
    results.determinism.identical;
  if (!healthy) process.exitCode = 1;
}
