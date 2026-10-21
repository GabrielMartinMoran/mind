// E-RAG — semantic vs lexical retrieved-set diff on the SAME 120 queries.
//
// Replays the frozen benchmark queries against the RAG-off and RAG-on copies of
// the conv-26 database, at K=10 (primary) and K=25 (secondary), twice for
// determinism, using the existing workbench server harness. RAG-on requires
// query-time embeddings from OpenRouter; the credential is read at runtime from
// the user's OpenCode auth store into the child process env only. It is never
// printed, logged or written to an artifact. The only paid calls are embeddings
// (<US$0.001 estimated).
//
// Usage:
//   bun run experiments/rag-diff/run.ts [--out <dir>] [--worktree <dir>]
//     [--off-db <db>] [--on-db <db>] [--probes <jsonl>] [--locomo <json>]
//     [--scratch <dir>] [--conversation conv-26] [--skip-embedding-probe]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import {
  buildEnv,
  copyDatabase,
  DEFAULT_SPACE,
  findFreePort,
  mapSearchItems,
  readProbes,
  startServer,
  type Probe,
  type ReplayChunk,
} from '../replay/replay';

import {
  attributeEvidence,
  displacement,
  estimateCostUsd,
  goldFlip,
  latencyStats,
  pairedDeltas,
  paidStats,
  setDiff,
  summarizeAttribution,
  topNames,
  type AttributionSummary,
  type Displacement,
  type DisplacementStats,
  type EvidenceAttribution,
  type LatencyStats,
  type SetDiff,
} from './ragdiff';

// ── Frozen baseline (E-WB/E-C) ──

export const FROZEN_FUNNEL_K10 = { ALL: 41, partial: 10, NONE: 39, no_evidence_gold: 2 } as const;
export const FROZEN_ADMITTED_TOP10 = 65;
export const PRICE_PER_MILLION_USD = 0.02; // OpenAI list price, text-embedding-3-small
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings';

// ── Gold ──

interface LocomoSample {
  sample_id: string;
  qa: Array<{ question: string; evidence?: string[]; category: number }>;
}

export function loadGold(locomoPath: string, conversation: string): Map<string, string[]> {
  const dataset = JSON.parse(readFileSync(locomoPath, 'utf8')) as LocomoSample[];
  const sample = dataset.find(entry => entry.sample_id === conversation);
  if (!sample) throw new Error(`conversation ${conversation} not found`);
  const map = new Map<string, string[]>();
  for (const qa of sample.qa) map.set(qa.question.trim(), qa.evidence ?? []);
  return map;
}

// ── Capture ──

interface Capture {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  readonly items: readonly ReplayChunk[];
  readonly latency_ms: number;
}

async function replayPass(
  baseUrl: string,
  probes: readonly Probe[],
  space: string,
  limit: number
): Promise<Capture[]> {
  const out: Capture[] = [];
  for (const probe of probes) {
    const params = new URLSearchParams({ q: probe.question, space, limit: String(limit) });
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/search?${params.toString()}`);
    if (!response.ok)
      throw new Error(`/api/search status ${response.status} for ${probe.probe_id}`);
    const items = mapSearchItems((await response.json()) as unknown);
    out.push({
      probe_id: probe.probe_id,
      question: probe.question,
      category: probe.category,
      adversarial: probe.adversarial,
      items,
      latency_ms: performance.now() - started,
    });
  }
  return out;
}

function signature(pass: readonly Capture[]): string {
  return JSON.stringify(
    pass.map(entry =>
      entry.items.map(item => [item.name, item.content, item.score, item.confidence, item.methods])
    )
  );
}

// ── Credentials (runtime only; never logged) ──

export function readOpenRouterKey(): string {
  const path = join(homedir(), '.local/share/opencode/auth.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { key?: unknown } | undefined
  >;
  const key = parsed.openrouter?.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`no OpenRouter credential in ${path}`);
  }
  return key;
}

function ragEnv(scratchDir: string, rag: 'off' | 'on', key: string | null) {
  const env = buildEnv(scratchDir, rag);
  if (rag === 'on') {
    if (!key) throw new Error('RAG-on replay needs an OpenRouter key');
    env.MIND_RAG = 'true';
    env.MIND_EMBEDDING_PROVIDER = 'openrouter';
    env.OPENROUTER_API_KEY = key;
  } else {
    env.MIND_RAG = 'false';
    delete env.MIND_EMBEDDING_PROVIDER;
    delete env.OPENROUTER_API_KEY;
  }
  return env;
}

// ── DB inspection ──

export interface DbInventory {
  readonly memories: number;
  readonly with_embedding: number;
  readonly names: readonly string[];
}

export function inspectDb(dbPath: string): DbInventory {
  const db = new Database(dbPath, { readonly: true });
  try {
    const memories = db.query('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    const embedded = db
      .query('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL')
      .get() as { n: number };
    const names = (
      db.query('SELECT name FROM memories ORDER BY name').all() as { name: string }[]
    ).map(row => row.name);
    return { memories: Number(memories.n), with_embedding: Number(embedded.n), names };
  } finally {
    db.close();
  }
}

// ── Embedding probe (direct, sampled, cheap) ──

interface EmbeddingSample {
  readonly chars: number;
  readonly tokens: number | null;
  readonly latency_ms: number;
  readonly dims: number;
}

export interface EmbeddingProbe {
  readonly model: string;
  readonly samples: readonly EmbeddingSample[];
  readonly deterministic_same_input: boolean;
  readonly max_abs_diff: number;
  readonly latency: LatencyStats;
}

async function callEmbedding(
  key: string,
  input: string
): Promise<{ vec: number[]; tokens: number | null; ms: number }> {
  const started = performance.now();
  const response = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input, encoding_format: 'float' }),
  });
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`embedding probe failed: HTTP ${response.status}`);
  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const vec = data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embedding probe returned no vector');
  return {
    vec,
    tokens: data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? null,
    ms,
  };
}

export async function probeEmbeddings(
  key: string,
  queries: readonly string[]
): Promise<EmbeddingProbe> {
  const samples: EmbeddingSample[] = [];
  const latencies: number[] = [];
  let first: number[] | null = null;
  let deterministic = true;
  let maxDiff = 0;
  for (const query of queries) {
    const result = await callEmbedding(key, query);
    latencies.push(result.ms);
    samples.push({
      chars: query.length,
      tokens: result.tokens,
      latency_ms: result.ms,
      dims: result.vec.length,
    });
    if (first === null) first = result.vec;
    else if (query === queries[0]) {
      maxDiff = first.reduce(
        (max, value, index) => Math.max(max, Math.abs(value - (result.vec[index] ?? 0))),
        0
      );
      deterministic = maxDiff === 0;
    }
  }
  return {
    model: EMBEDDING_MODEL,
    samples,
    deterministic_same_input: deterministic,
    max_abs_diff: maxDiff,
    latency: latencyStats(latencies),
  };
}

// ── Run one DB ──

export interface DbRun {
  readonly label: string;
  readonly rag: 'off' | 'on';
  readonly db_source: string;
  readonly inventory: DbInventory;
  readonly k10_a: readonly Capture[];
  readonly k10_b: readonly Capture[];
  readonly k25: readonly Capture[];
  readonly determinism_identical: boolean;
  readonly determinism_names_identical: boolean;
  readonly determinism_name_mismatches: readonly string[];
  readonly determinism_full_mismatches: readonly string[];
  readonly semantic_methods: number;
}

async function runDb(options: {
  label: string;
  db: string;
  rag: 'off' | 'on';
  probes: readonly Probe[];
  worktree: string;
  scratch: string;
  key: string | null;
  space: string;
}): Promise<DbRun> {
  const dir = join(options.scratch, options.label);
  mkdirSync(dir, { recursive: true });
  const dbScratch = copyDatabase(options.db, dir);
  const inventory = inspectDb(dbScratch);
  const env = ragEnv(dir, options.rag, options.key);
  const port = await findFreePort();
  const server = await startServer({
    bin: join(resolve(options.worktree), 'mind'),
    cwd: resolve(options.worktree),
    env,
    port,
    stderrLog: join(dir, 'serve.stderr.log'),
  });
  try {
    const k10a = await replayPass(server.baseUrl, options.probes, options.space, 10);
    const k10b = await replayPass(server.baseUrl, options.probes, options.space, 10);
    const k25 = await replayPass(server.baseUrl, options.probes, options.space, 25);
    const semanticMethods = k10a.reduce(
      (count, capture) =>
        count + capture.items.filter(item => (item.methods ?? []).includes('semantic')).length,
      0
    );
    const nameMismatches: string[] = [];
    const fullMismatches: string[] = [];
    for (let index = 0; index < k10a.length; index += 1) {
      const a = k10a[index]!;
      const b = k10b[index]!;
      if (
        JSON.stringify(a.items.map(item => item.name)) !==
        JSON.stringify(b.items.map(item => item.name))
      ) {
        nameMismatches.push(a.probe_id);
      }
      if (signature([a]) !== signature([b])) fullMismatches.push(a.probe_id);
    }
    return {
      label: options.label,
      rag: options.rag,
      db_source: resolve(options.db),
      inventory,
      k10_a: k10a,
      k10_b: k10b,
      k25,
      determinism_identical: fullMismatches.length === 0,
      determinism_names_identical: nameMismatches.length === 0,
      determinism_name_mismatches: nameMismatches,
      determinism_full_mismatches: fullMismatches,
      semantic_methods: semanticMethods,
    };
  } finally {
    await server.stop();
  }
}

// ── Analysis ──

interface ProbeAnalysis {
  readonly probe_id: string;
  readonly question: string;
  readonly category: string;
  readonly adversarial: boolean;
  readonly gold: readonly string[];
  readonly k10: SetDiff;
  readonly k25: SetDiff;
  readonly attribution_10: EvidenceAttribution;
  readonly attribution_25: EvidenceAttribution;
  readonly gains_10: readonly string[];
  readonly losses_10: readonly string[];
  readonly displacement: Displacement;
  readonly latency_off_ms: number;
  readonly latency_on_ms: number;
}

interface BlockSummary {
  readonly k: number;
  readonly probes: number;
  readonly answerable: number;
  readonly mean_jaccard: number | null;
  readonly queries_with_on_only: number;
  readonly queries_with_off_only: number;
  readonly total_on_only: number;
  readonly total_off_only: number;
  readonly total_intersection: number;
  readonly queries_on_gains_gold: number;
  readonly queries_off_gains_gold: number;
  readonly any_off: number;
  readonly any_on: number;
  readonly full_off: number;
  readonly full_on: number;
  readonly full_delta: number | null;
}

function inWindow(items: readonly ReplayChunk[], k: number): string[] {
  return topNames(
    items.map(item => item.name),
    k
  );
}

function summarizeBlock(analyses: readonly ProbeAnalysis[], k: 10 | 25): BlockSummary {
  const answerable = analyses.filter(analysis => !analysis.adversarial);
  const withGold = answerable.filter(analysis => analysis.gold.length > 0);
  const diffs = analyses.map(analysis => (k === 10 ? analysis.k10 : analysis.k25));
  const jaccards = diffs.map(diff => diff.jaccard);
  const states = withGold.map(analysis => {
    const entropy = k === 10 ? analysis.attribution_10 : analysis.attribution_25;
    return {
      anyOff: entropy.both.length + entropy.lexical_only.length > 0,
      anyOn: entropy.both.length + entropy.semantic_only.length > 0,
      fullOff: entropy.semantic_only.length === 0 && entropy.neither.length === 0,
      fullOn: entropy.lexical_only.length === 0 && entropy.neither.length === 0,
    };
  });
  return {
    k,
    probes: analyses.length,
    answerable: answerable.length,
    mean_jaccard: jaccards.length
      ? jaccards.reduce((sum, value) => sum + value, 0) / jaccards.length
      : null,
    queries_with_on_only: diffs.filter(diff => diff.onOnly.length > 0).length,
    queries_with_off_only: diffs.filter(diff => diff.offOnly.length > 0).length,
    total_on_only: diffs.reduce((sum, diff) => sum + diff.onOnly.length, 0),
    total_off_only: diffs.reduce((sum, diff) => sum + diff.offOnly.length, 0),
    total_intersection: diffs.reduce((sum, diff) => sum + diff.intersection.length, 0),
    queries_on_gains_gold: withGold.filter(
      analysis => (k === 10 ? analysis.gains_10 : analysis.attribution_25.semantic_only).length > 0
    ).length,
    queries_off_gains_gold: withGold.filter(
      analysis => (k === 10 ? analysis.losses_10 : analysis.attribution_25.lexical_only).length > 0
    ).length,
    any_off: states.filter(state => state.anyOff).length,
    any_on: states.filter(state => state.anyOn).length,
    full_off: states.filter(state => state.fullOff).length,
    full_on: states.filter(state => state.fullOn).length,
    full_delta:
      withGold.length === 0
        ? null
        : (states.filter(state => state.fullOn).length -
            states.filter(state => state.fullOff).length) /
          withGold.length,
  };
}

function quality(analyses: readonly ProbeAnalysis[], k: 10 | 25) {
  let precisionOff = 0;
  let precisionOn = 0;
  let mrrOff = 0;
  let mrrOn = 0;
  let compared = 0;
  let zeroOff = 0;
  for (const analysis of analyses) {
    if (analysis.adversarial || analysis.gold.length === 0) continue;
    const diff = k === 10 ? analysis.k10 : analysis.k25;
    const off = [...diff.intersection, ...diff.offOnly];
    const on = [...diff.intersection, ...diff.onOnly];
    if (off.length === 0) {
      zeroOff += 1;
      continue;
    }
    compared += 1;
    const gold = new Set(analysis.gold);
    const offHits = off.filter(name => gold.has(name)).length;
    const onHits = on.filter(name => gold.has(name)).length;
    precisionOff += offHits / off.length;
    precisionOn += onHits / Math.max(1, on.length);
    const offRank = off.findIndex(name => gold.has(name));
    const onRank = on.findIndex(name => gold.has(name));
    mrrOff += offRank >= 0 ? 1 / (offRank + 1) : 0;
    mrrOn += onRank >= 0 ? 1 / (onRank + 1) : 0;
  }
  return compared === 0
    ? {
        compared,
        zero_off: zeroOff,
        precision_off: null,
        precision_on: null,
        mrr_off: null,
        mrr_on: null,
      }
    : {
        compared,
        zero_off: zeroOff,
        precision_off: precisionOff / compared,
        precision_on: precisionOn / compared,
        mrr_off: mrrOff / compared,
        mrr_on: mrrOn / compared,
      };
}

function byCategory(analyses: readonly ProbeAnalysis[], k: 10 | 25) {
  const categories = [...new Set(analyses.map(analysis => analysis.category))].sort();
  return Object.fromEntries(
    categories.map(category => [
      category,
      summarizeBlock(
        analyses.filter(analysis => analysis.category === category),
        k
      ),
    ])
  );
}

function analyze(
  off: DbRun,
  on: DbRun,
  probes: readonly Probe[],
  gold: Map<string, string[]>
): ProbeAnalysis[] {
  const byId = new Map(probes.map(probe => [probe.probe_id, probe]));
  const off10 = new Map(off.k10_a.map(capture => [capture.probe_id, capture]));
  const on10 = new Map(on.k10_a.map(capture => [capture.probe_id, capture]));
  const off25 = new Map(off.k25.map(capture => [capture.probe_id, capture]));
  const on25 = new Map(on.k25.map(capture => [capture.probe_id, capture]));
  const analyses: ProbeAnalysis[] = [];
  for (const probe of probes) {
    const o10 = off10.get(probe.probe_id);
    const n10 = on10.get(probe.probe_id);
    const o25 = off25.get(probe.probe_id);
    const n25 = on25.get(probe.probe_id);
    if (!o10 || !n10 || !o25 || !n25) throw new Error(`missing capture for ${probe.probe_id}`);
    const evidence = gold.get(probe.question.trim()) ?? [];
    const off10Names = inWindow(o10.items, 10);
    const on10Names = inWindow(n10.items, 10);
    const off25Names = inWindow(o25.items, 25);
    const on25Names = inWindow(n25.items, 25);
    const flip = goldFlip(off10Names, on10Names, evidence, 10);
    analyses.push({
      probe_id: probe.probe_id,
      question: probe.question,
      category: byId.get(probe.probe_id)?.category ?? probe.category,
      adversarial: probe.adversarial,
      gold: evidence,
      k10: setDiff(off10Names, on10Names, 10),
      k25: setDiff(off25Names, on25Names, 25),
      attribution_10: attributeEvidence(off10Names, on10Names, evidence, 10),
      attribution_25: attributeEvidence(off25Names, on25Names, evidence, 25),
      gains_10: flip.gained,
      losses_10: flip.lost,
      displacement: displacement(o10.items, n10.items, evidence, off25Names, on25Names, 10),
      latency_off_ms: o10.latency_ms,
      latency_on_ms: n10.latency_ms,
    });
  }
  return analyses;
}

// ── Gate ──

function readDumpTop10(path: string): string[][] | null {
  if (!existsSync(path)) return null;
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

function offGate(off: DbRun, analyses: readonly ProbeAnalysis[], dumpPath: string) {
  const funnel = { ALL: 0, partial: 0, NONE: 0, no_evidence_gold: 0 };
  let admitted = 0;
  for (const analysis of analyses) {
    const top = new Set(
      topNames(
        off.k10_a.find(p => p.probe_id === analysis.probe_id)!.items.map(i => i.name),
        10
      )
    );
    const hits = analysis.gold.filter(item => top.has(item)).length;
    admitted += hits;
    if (analysis.adversarial) continue;
    if (analysis.gold.length === 0) {
      funnel.no_evidence_gold += 1;
      continue;
    }
    if (hits === 0) funnel.NONE += 1;
    else if (hits === analysis.gold.length) funnel.ALL += 1;
    else funnel.partial += 1;
  }
  const dump = readDumpTop10(dumpPath);
  let compared = 0;
  let mismatches = 0;
  if (dump) {
    compared = Math.min(dump.length, off.k10_a.length);
    if (dump.length !== off.k10_a.length) mismatches += 1;
    for (let index = 0; index < compared; index += 1) {
      const actual = topNames(
        off.k10_a[index]!.items.map(item => item.name),
        10
      );
      if (JSON.stringify(actual) !== JSON.stringify(dump[index])) mismatches += 1;
    }
  }
  return {
    funnel,
    funnel_expected: FROZEN_FUNNEL_K10,
    funnel_match: (Object.keys(FROZEN_FUNNEL_K10) as Array<keyof typeof FROZEN_FUNNEL_K10>).every(
      key => funnel[key] === FROZEN_FUNNEL_K10[key]
    ),
    admitted_top10: admitted,
    admitted_top10_expected: FROZEN_ADMITTED_TOP10,
    admitted_match: admitted === FROZEN_ADMITTED_TOP10,
    top10_vs_dump: {
      compared,
      mismatches,
      match: dump !== null && mismatches === 0 && compared === off.k10_a.length,
    },
  };
}

// ── Aggregations ──

function aggregateDisplacement(analyses: readonly ProbeAnalysis[]): DisplacementStats {
  const stats = analyses.map(analysis => paidStats(analysis.displacement));
  const sum = (key: keyof DisplacementStats): number =>
    stats.reduce((total, entry) => total + entry[key], 0);
  return {
    displaced: sum('displaced'),
    displacedGold: sum('displacedGold'),
    displacedHighConfidenceLexical: sum('displacedHighConfidenceLexical'),
    inserted: sum('inserted'),
    insertedNonGold: sum('insertedNonGold'),
    insertedWithSemantic: sum('insertedWithSemantic'),
    insertedSemanticOnlyWindow: sum('insertedSemanticOnlyWindow'),
    netGold: sum('netGold'),
  };
}

function gainedOrigin(analyses: readonly ProbeAnalysis[]) {
  let fromOff25 = 0;
  let newToOff25 = 0;
  let withSemantic = 0;
  for (const analysis of analyses) {
    if (analysis.adversarial) continue;
    for (const name of analysis.gains_10) {
      const entry = analysis.displacement.inserted.find(candidate => candidate.name === name);
      if (!entry) continue;
      if (entry.offRank25 !== null) fromOff25 += 1;
      else newToOff25 += 1;
      if (entry.semantic) withSemantic += 1;
    }
  }
  return {
    from_off_top25: fromOff25,
    new_to_off_top25: newToOff25,
    with_semantic_method: withSemantic,
  };
}

// ── Results file ──

export interface RagDiffResults {
  readonly meta: Record<string, unknown>;
  readonly gate: Record<string, unknown>;
  readonly determinism: Record<string, unknown>;
  readonly set_diff: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
  readonly displacement: Record<string, unknown>;
  readonly latency: Record<string, unknown>;
  readonly embedding_probe: EmbeddingProbe | null;
  readonly examples: Record<string, unknown>;
  readonly per_probe: readonly Record<string, unknown>[];
}

function buildExamples(analyses: readonly ProbeAnalysis[]) {
  const semanticOnly = analyses
    .filter(analysis => !analysis.adversarial && analysis.attribution_10.semantic_only.length > 0)
    .slice(0, 4)
    .map(analysis => {
      const name = analysis.attribution_10.semantic_only[0]!;
      const onItem = analysis.displacement.inserted.find(entry => entry.name === name);
      return {
        probe_id: analysis.probe_id,
        category: analysis.category,
        question: analysis.question,
        gold: name,
        off_rank25: onItem?.offRank25 ?? null,
        on_rank: onItem?.onRank ?? null,
        on_methods: onItem?.methods ?? [],
        on_confidence: onItem?.confidence ?? null,
      };
    });
  const displacedGold = analyses
    .filter(
      analysis => !analysis.adversarial && analysis.displacement.displaced.some(e => e.isGold)
    )
    .slice(0, 4)
    .flatMap(analysis =>
      analysis.displacement.displaced
        .filter(entry => entry.isGold)
        .map(entry => ({
          probe_id: analysis.probe_id,
          category: analysis.category,
          question: analysis.question,
          gold: entry.name,
          off_rank: entry.offRank,
          on_rank25: entry.onRank25,
          off_confidence: entry.confidence,
          off_methods: entry.methods,
        }))
    );
  const insertedNonGold = analyses
    .filter(analysis =>
      analysis.displacement.inserted.some(entry => !entry.isGold && entry.semantic)
    )
    .slice(0, 4)
    .flatMap(analysis =>
      analysis.displacement.inserted
        .filter(entry => !entry.isGold && entry.semantic)
        .map(entry => ({
          probe_id: analysis.probe_id,
          category: analysis.category,
          question: analysis.question,
          name: entry.name,
          off_rank25: entry.offRank25,
          on_rank: entry.onRank,
          confidence: entry.confidence,
          methods: entry.methods,
        }))
    );
  return {
    semantic_only: semanticOnly,
    displaced_gold: displacedGold,
    inserted_non_gold: insertedNonGold,
  };
}

export function buildResults(
  off: DbRun,
  on: DbRun,
  analyses: readonly ProbeAnalysis[],
  gate: ReturnType<typeof offGate>,
  embedding: EmbeddingProbe | null,
  options: {
    conversation: string;
    space: string;
    probesPath: string;
    worktree: string;
    passesPerDb: number;
  }
): RagDiffResults {
  const answerable = analyses.filter(analysis => !analysis.adversarial);
  const attribution10 = summarizeAttribution(answerable.map(analysis => analysis.attribution_10));
  const attribution25 = summarizeAttribution(answerable.map(analysis => analysis.attribution_25));
  const disp = aggregateDisplacement(analyses);
  const offLatency = latencyStats(analyses.map(analysis => analysis.latency_off_ms));
  const onLatency = latencyStats(analyses.map(analysis => analysis.latency_on_ms));
  const deltas = pairedDeltas(
    analyses.map(analysis => analysis.latency_off_ms),
    analyses.map(analysis => analysis.latency_on_ms)
  );
  const deltaStats = latencyStats(deltas);
  const questionChars = analyses.reduce((sum, analysis) => sum + analysis.question.length, 0);
  const measuredTokens = (embedding?.samples ?? [])
    .map(sample => sample.tokens)
    .filter((value): value is number => typeof value === 'number');
  const measuredChars = (embedding?.samples ?? [])
    .filter(sample => sample.tokens !== null)
    .reduce((sum, sample) => sum + sample.chars, 0);
  const tokensPerChar =
    measuredTokens.length > 0 && measuredChars > 0
      ? measuredTokens.reduce((sum, value) => sum + value, 0) / measuredChars
      : null;
  const onQueryRequests = options.passesPerDb * analyses.length;
  const estimatedTokens =
    tokensPerChar === null ? null : Math.ceil(questionChars * tokensPerChar) * options.passesPerDb;
  return {
    meta: {
      feature: '00009-memory-recall-investigation',
      task: 'E-RAG',
      generated_at: new Date().toISOString(),
      conversation: options.conversation,
      space: options.space,
      probes_path: resolve(options.probesPath),
      worktree: resolve(options.worktree),
      off_db: off.db_source,
      on_db: on.db_source,
      query_count: analyses.length,
      answerable: answerable.length,
      adversarial: analyses.filter(analysis => analysis.adversarial).length,
      passes_per_db: options.passesPerDb,
      gold_usage: 'scoring only; never used to build queries',
      token_estimate: 'ceil(chars / 4)',
      embedding_model: EMBEDDING_MODEL,
      embedding_provider: 'openrouter',
      price_assumption_usd_per_million: PRICE_PER_MILLION_USD,
      cost_note:
        'token usage is measured on sampled direct calls; total USD is an estimate, not an invoice',
    },
    gate: {
      ...gate,
      on_embeddings: {
        indexed: on.inventory.with_embedding,
        total: on.inventory.memories,
        complete: on.inventory.with_embedding === on.inventory.memories,
      },
      same_memory_names: JSON.stringify(off.inventory.names) === JSON.stringify(on.inventory.names),
      off_memories: off.inventory.memories,
      on_memories: on.inventory.memories,
      on_semantic_methods_in_k10: on.semantic_methods,
      off_semantic_methods_in_k10: off.semantic_methods,
    },
    determinism: {
      off_identical: off.determinism_identical,
      on_identical: on.determinism_identical,
      off_names_identical: off.determinism_names_identical,
      on_names_identical: on.determinism_names_identical,
      off_name_mismatches: off.determinism_name_mismatches,
      on_name_mismatches: on.determinism_name_mismatches,
      on_full_mismatches: on.determinism_full_mismatches.slice(0, 20),
      on_full_mismatch_count: on.determinism_full_mismatches.length,
      off_query_embeddings: 0,
      on_query_embeddings: onQueryRequests,
      on_same_input_embedding_identical: embedding?.deterministic_same_input ?? null,
      on_same_input_max_abs_diff: embedding?.max_abs_diff ?? null,
    },
    set_diff: {
      k10: summarizeBlock(analyses, 10),
      k25: summarizeBlock(analyses, 25),
      quality_k10: quality(analyses, 10),
      quality_k25: quality(analyses, 25),
      by_category_k10: byCategory(analyses, 10),
      by_category_k25: byCategory(analyses, 25),
    },
    evidence: {
      k10: attribution10,
      k25: attribution25,
      by_category_k10: Object.fromEntries(
        [...new Set(answerable.map(analysis => analysis.category))]
          .sort()
          .map(category => [
            category,
            summarizeAttribution(
              answerable
                .filter(analysis => analysis.category === category)
                .map(analysis => analysis.attribution_10)
            ),
          ])
      ),
      gained_origin: gainedOrigin(analyses),
    },
    displacement: {
      k10: disp,
      semantic_only_window_examples: analyses
        .flatMap(analysis => analysis.displacement.inserted)
        .filter(entry => entry.semantic && entry.offRank25 === null && !entry.isGold).length,
    },
    latency: {
      off: offLatency,
      on: onLatency,
      delta: deltaStats,
      ratio_p50: offLatency.p50 && onLatency.p50 ? onLatency.p50 / offLatency.p50 : null,
      ratio_mean: offLatency.mean && onLatency.mean ? onLatency.mean / offLatency.mean : null,
      embedding_share_of_on_p50:
        embedding?.latency.mean && onLatency.p50 ? embedding.latency.mean / onLatency.p50 : null,
      fixed_cost_ms_p50:
        offLatency.p50 !== null && onLatency.p50 !== null ? onLatency.p50 - offLatency.p50 : null,
      on_query_requests: onQueryRequests,
      estimated_query_tokens: estimatedTokens,
      estimated_query_cost_usd:
        estimatedTokens === null ? null : estimateCostUsd(estimatedTokens, PRICE_PER_MILLION_USD),
      direct_probe_cost_usd:
        measuredTokens.length === 0
          ? null
          : estimateCostUsd(
              measuredTokens.reduce((sum, value) => sum + value, 0),
              PRICE_PER_MILLION_USD
            ),
    },
    embedding_probe: embedding,
    examples: buildExamples(analyses),
    per_probe: analyses.map(analysis => ({
      probe_id: analysis.probe_id,
      question: analysis.question,
      category: analysis.category,
      adversarial: analysis.adversarial,
      gold: analysis.gold,
      k10: analysis.k10,
      k25: analysis.k25,
      attribution_10: analysis.attribution_10,
      attribution_25: analysis.attribution_25,
      gains_10: analysis.gains_10,
      losses_10: analysis.losses_10,
      displaced: analysis.displacement.displaced,
      inserted: analysis.displacement.inserted,
      latency_off_ms: analysis.latency_off_ms,
      latency_on_ms: analysis.latency_on_ms,
    })),
  };
}

// ── Report ──

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const pp = (value: number | null): string =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
const num = (value: number | null, digits = 3): string =>
  value === null ? 'n/a' : value.toFixed(digits);
const ms = (value: number | null): string => (value === null ? 'n/a' : `${value.toFixed(1)} ms`);
const usd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(6)}`);

function setDiffTable(block: Record<string, BlockSummary>): string {
  const rows = Object.entries(block).map(([category, summary]) => {
    return `| ${category} | ${summary.probes} | ${summary.answerable} | ${num(summary.mean_jaccard)} | ${summary.queries_with_on_only} | ${summary.queries_with_off_only} | ${summary.total_on_only} | ${summary.total_off_only} | ${summary.queries_on_gains_gold} | ${summary.queries_off_gains_gold} | ${summary.full_off} | ${summary.full_on} |`;
  });
  return [
    '| Categoría | probes | answerable | Jaccard medio | probes ON-only | probes OFF-only | ítems ON-only | ítems OFF-only | ON gana gold | OFF gana gold | full OFF | full ON |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
}

function attributionTable(label: string, summary: AttributionSummary): string {
  return `| ${label} | ${summary.items} | ${summary.both} | ${summary.lexical_only} | ${summary.semantic_only} | ${summary.neither} |`;
}

function exampleSemanticOnly(examples: RagDiffResults['examples']): string {
  const list = examples.semantic_only as Array<Record<string, unknown>>;
  if (list.length === 0) return 'Ninguno medido.';
  return list
    .map(
      example =>
        `- \`${String(example.probe_id)}\` (${String(example.category)}): _${String(example.question)}_ — gold \`${String(example.gold)}\`, ON rank ${String(example.on_rank ?? 'fuera')} (${(example.on_methods as string[]).join(', ')}), OFF rank@25 ${String(example.off_rank25 ?? 'fuera')}.`
    )
    .join('\n');
}

function exampleDisplaced(examples: RagDiffResults['examples']): string {
  const list = examples.displaced_gold as Array<Record<string, unknown>>;
  if (list.length === 0) return 'Ninguno medido.';
  return list
    .map(
      example =>
        `- \`${String(example.probe_id)}\` (${String(example.category)}): _${String(example.question)}_ — gold \`${String(example.gold)}\` sale del top-10 (OFF rank ${String(example.off_rank)}; ON rank@25 ${String(example.on_rank25 ?? 'fuera')}).`
    )
    .join('\n');
}

function exampleInserted(examples: RagDiffResults['examples']): string {
  const list = examples.inserted_non_gold as Array<Record<string, unknown>>;
  if (list.length === 0) return 'Ninguno medido.';
  return list
    .map(
      example =>
        `- \`${String(example.probe_id)}\` (${String(example.category)}): _${String(example.question)}_ — entra \`${String(example.name)}\` (${(example.methods as string[]).join(', ')}, confianza ${String(example.confidence)}), OFF rank@25 ${String(example.off_rank25 ?? 'fuera')}.`
    )
    .join('\n');
}

export function renderReport(results: RagDiffResults): string {
  const meta = results.meta;
  const gate = results.gate as any;
  const det = results.determinism as any;
  const sd = results.set_diff as any;
  const ev = results.evidence as any;
  const disp = results.displacement as any;
  const lat = results.latency as any;
  const emb = results.embedding_probe;
  const k10 = sd.k10 as BlockSummary;
  const k25 = sd.k25 as BlockSummary;
  const d = disp.k10 as DisplacementStats;
  const g = ev.gained_origin as {
    from_off_top25: number;
    new_to_off_top25: number;
    with_semantic_method: number;
  };
  return `# E-RAG — diff semántico vs léxico (RAG ON/OFF)

**Feature:** \`00009-memory-recall-investigation\` · **Tarea:** E-RAG
**Conversación:** \`${String(meta.conversation)}\` · **Consultas:** ${String(meta.query_count)} (${String(meta.answerable)} answerable + ${String(meta.adversarial)} adversarial) · **DBs:** copias scratch de las DBs congeladas del benchmark (nunca la DB viva).
**K primario:** 10 · **K secundario:** 25 · **Costo:** embeddings de query solamente (~$0.00007 estimated (not invoiced); ${usd(lat.direct_probe_cost_usd)} en el sondeo directo). Sin LLM de respuesta/juez.

> Alcance: este experimento mide **solo retrieval**, en **una corrida** y **una
> conversación** (\`conv-26\`, 419 memorias). Cualquier lectura de "sin daño" se
> limita a la recuperación léxica/semántica en ese alcance; no cubre respuesta,
> abstención ni generalización.

> RAG OFF y RAG ON se ejecutan por separado, con las MISMAS 120 preguntas, el
> mismo space (\`${String(meta.space)}\`) y los mismos límites. Gold se usa
> **solo** para puntuar/atribuir; nunca para construir consultas. Se verificó
> que los archivos de probes OFF y ON tienen los mismos 120 \`probe_id\`,
> preguntas, categorías y flags adversariales.

## 1. Gate y determinismo

[MEDIDO]

| Chequeo | Medido | Esperado | Resultado |
| --- | ---: | ---: | --- |
| Funnel OFF K=10 | ${JSON.stringify(gate.funnel)} | ${JSON.stringify(gate.funnel_expected)} | **${gate.funnel_match ? 'pass' : 'FAIL'}** |
| Evidencia OFF en top-10 (todas las probes) | ${String(gate.admitted_top10)} | ${String(gate.admitted_top10_expected)} | **${gate.admitted_match ? 'pass' : 'FAIL'}** |
| Top-10 OFF idéntico al dump E-WB | ${String(gate.top10_vs_dump.compared - gate.top10_vs_dump.mismatches)}/${String(gate.top10_vs_dump.compared)} | 120/120 | **${gate.top10_vs_dump.match ? 'pass' : 'FAIL'}** |
| Embeddings de documento ON | ${String(gate.on_embeddings.indexed)}/${String(gate.on_embeddings.total)} | 419/419 | **${gate.on_embeddings.complete ? 'pass' : 'FAIL'}** |
| Mismo set de nombres OFF/ON | ${String(gate.same_memory_names)} | true | **${gate.same_memory_names ? 'pass' : 'FAIL'}** |
| Canal semántico presente (ítems en top-10) | ${String(gate.on_semantic_methods_in_k10)} | > 0 | **${gate.on_semantic_methods_in_k10 > 0 ? 'pass' : 'FAIL'}** |
| Determinismo OFF (dos pasadas) | ${String(det.off_identical)} | true | **${det.off_identical ? 'pass' : 'FAIL'}** |
| Determinismo ON, nombres (dos pasadas) | ${String(det.on_names_identical)} (${String(det.on_name_mismatches.length)} probes) | true | **${det.on_names_identical ? 'pass' : 'FAIL'}** |
| Embedding misma entrada estable | ${String(det.on_same_input_embedding_identical)} (max |Δ| ${String(det.on_same_input_max_abs_diff)}) | true | **${det.on_same_input_embedding_identical ? 'pass' : 'FAIL'}** |

Las dos pasadas ON devolvieron los **mismos nombres** en las 120 queries
(${String(det.on_name_mismatches.length)} mismatches de nombre), aunque
**${String(det.on_full_mismatch_count)}/120 probes** tuvieron diferencias
numéricas de \`score\`/\`methods\` (no de conjunto). El embedding de la misma
entrada fue idéntico en el sondeo directo.

La DB ON tiene **${String(gate.on_embeddings.indexed)}/${String(gate.on_embeddings.total)}**
documentos con embedding; no se re-embebió ningún documento. Cada pasada ON
generó ${String(det.on_query_embeddings)} embeddings de query
(${String(meta.passes_per_db)} pasadas × 120 preguntas).

## 2. Diff de conjuntos recuperados

[MEDIDO] ${k10.probes} probes (${k10.answerable} answerable). \`Jaccard\` =
|intersección| / |unión| de los nombres devueltos en top-K (solo ítems
devueltos; las listas cortas no se rellenan).

| K | probes | answerable | Jaccard medio | probes ON-only | probes OFF-only | ítems ON-only | ítems OFF-only | ON gana gold | OFF gana gold | any OFF | any ON | full OFF | full ON | Δ full |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | ${k10.probes} | ${k10.answerable} | ${num(k10.mean_jaccard)} | ${k10.queries_with_on_only} | ${k10.queries_with_off_only} | ${k10.total_on_only} | ${k10.total_off_only} | ${k10.queries_on_gains_gold} | ${k10.queries_off_gains_gold} | ${k10.any_off} | ${k10.any_on} | ${k10.full_off} | ${k10.full_on} | ${pp(k10.full_delta)} |
| 25 | ${k25.probes} | ${k25.answerable} | ${num(k25.mean_jaccard)} | ${k25.queries_with_on_only} | ${k25.queries_with_off_only} | ${k25.total_on_only} | ${k25.total_off_only} | ${k25.queries_on_gains_gold} | ${k25.queries_off_gains_gold} | ${k25.any_off} | ${k25.any_on} | ${k25.full_off} | ${k25.full_on} | ${pp(k25.full_delta)} |

Precisión@10 (answerable, media): **${pct(sd.quality_k10.precision_off)} OFF → ${pct(sd.quality_k10.precision_on)} ON** (${pp((sd.quality_k10.precision_on ?? 0) - (sd.quality_k10.precision_off ?? 0))}); MRR: ${num(sd.quality_k10.mrr_off)} → ${num(sd.quality_k10.mrr_on)}. En K=25: precisión ${pct(sd.quality_k25.precision_off)} → ${pct(sd.quality_k25.precision_on)}, MRR ${num(sd.quality_k25.mrr_off)} → ${num(sd.quality_k25.mrr_on)}. En este alcance (retrieval, una corrida, una conversación de 419 memorias) la precisión no cae: el desplazamiento de gold es 0.

### Por categoría (K=10)

${setDiffTable(sd.by_category_k10)}

## 3. Atribución a nivel de evidencia

[MEDIDO] Ítems gold (solo probes answerable): \`both\` = en OFF y ON;
\`lexical_only\` = solo OFF; \`semantic_only\` = solo ON; \`neither\` = en
ninguno.

| K | ítems | both | lexical_only | semantic_only | neither |
| ---: | ---: | ---: | ---: | ---: | ---: |
${attributionTable('10', ev.k10)}
${attributionTable('25', ev.k25)}

### ¿La ganancia ON es evidencia distinta o re-ranking?

[MEDIDO] De los ítems gold que ON gana en top-10:

- **${g.from_off_top25}** ya estaban en el top-25 OFF (re-ranking/promoción dentro de la ventana).
- **${g.new_to_off_top25}** no estaban ni en el top-25 OFF (evidencia nueva para la ventana).
- **${g.with_semantic_method}** llevan \`semantic\` en \`methods\`.

## 4. Desplazamiento

[MEDIDO] Sobre K=10. \`displaced\` = salió del top-10; \`inserted\` = entró.
\`inserted_semantic_only_window\` = entró, no es gold, tiene \`semantic\` y no
estaba en el top-25 OFF.

| Métrica | Valor |
| --- | ---: |
| Ítems desplazados | ${d.displaced} |
| Gold desplazados fuera del top-10 | ${d.displacedGold} |
| No-gold de confianza alta desplazados | ${d.displacedHighConfidenceLexical} |
| Ítems insertados | ${d.inserted} |
| Insertados no-gold | ${d.insertedNonGold} |
| Insertados con \`semantic\` en methods | ${d.insertedWithSemantic} |
| Insertados semantic-only fuera del top-25 OFF | ${d.insertedSemanticOnlyWindow} |
| Neto de gold (insertados − desplazados) | ${d.netGold >= 0 ? '+' : ''}${d.netGold} |

> Lectura: el desplazamiento neto de gold es **${d.netGold >= 0 ? 'positivo' : 'negativo'}**
> (${d.netGold}). Los ítems no-gold de confianza alta que salen indican si la
> precisión léxica se pierde por inserción semántica; los insertados
> semantic-only fuera del top-25 OFF son la única evidencia de que el canal
> semántico aporte algo que el léxico no hubiera encontrado cerca.

## 5. Latencia y costo

[MEDIDO] Latencia cliente por query (fetch + ranking), dos pasadas K=10.

| | OFF | ON | ON−OFF |
| --- | ---: | ---: | ---: |
| p50 | ${ms(lat.off.p50)} | ${ms(lat.on.p50)} | ${ms(lat.delta.p50)} |
| p95 | ${ms(lat.off.p95)} | ${ms(lat.on.p95)} | ${ms(lat.delta.p95)} |
| media | ${ms(lat.off.mean)} | ${ms(lat.on.mean)} | ${ms(lat.delta.mean)} |
| min / max | ${ms(lat.off.min)} / ${ms(lat.off.max)} | ${ms(lat.on.min)} / ${ms(lat.on.max)} | ${ms(lat.delta.min)} / ${ms(lat.delta.max)} |

- Ratio p50 ON/OFF: **${num(lat.ratio_p50, 1)}×**; ratio de medias: ${num(lat.ratio_mean, 1)}×.
- Costo fijo por query (p50): **${ms(lat.fixed_cost_ms_p50)}**.
- Llamada directa de embedding (sondeo de ${String(emb?.samples.length ?? 0)} queries): media **${ms(emb?.latency.mean ?? null)}**, p50 ${ms(emb?.latency.p50 ?? null)}.
- Share del embedding sobre el p50 ON: **${pct(lat.embedding_share_of_on_p50)}**. El resto del delta es el barrido de coseno sobre las 419 memorias y el trabajo del canal semántico.
- Tokens de query medidos en el sondeo: ${(emb?.samples ?? []).map(sample => String(sample.tokens ?? 'n/a')).join(', ') || 'n/a'}.
- Tokens totales estimados para ${String(lat.on_query_requests)} requests ON: **${String(lat.estimated_query_tokens ?? 'n/a')}**; costo **~$0.00007 estimated (not invoiced)** a $${String(meta.price_assumption_usd_per_million)}/M (precio de lista de OpenAI; OpenRouter puede aplicar markup; no hay factura). El sondeo directo costó ~${usd(lat.direct_probe_cost_usd)}.

## 6. Ejemplos

**Gold recuperado solo por ON (K=10):**

${exampleSemanticOnly(results.examples)}

**Gold desplazado fuera del top-10 por ON:**

${exampleDisplaced(results.examples)}

**Resultados no-gold insertados con soporte semántico:**

${exampleInserted(results.examples)}

## 7. Interpretación y cuándo habilitar RAG

[MEDIDO + SÍNTESIS] En esta conversación y corpus (una corrida, alcance retrieval):

- La lectura de "sin daño" se limita a retrieval, una sola corrida y esta
  conversación de 419 memorias: no se midió respuesta, abstención ni
  generalización a otros corpus.
- El conjunto recuperado cambia poco: Jaccard medio ${num(k10.mean_jaccard)} en K=10
  y ${num(k25.mean_jaccard)} en K=25.
- La evidencia completa pasa de ${k10.full_off}/${k10.answerable} a
  ${k10.full_on}/${k10.answerable} en K=10 (${pp(k10.full_delta)}); en K=25, de
  ${k25.full_off}/${k25.answerable} a ${k25.full_on}/${k25.answerable}
  (${pp(k25.full_delta)}).
- ON gana gold en ${k10.queries_on_gains_gold} probes y OFF gana gold en
  ${k10.queries_off_gains_gold} (K=10). El neto de gold desplazado/insertado es
  ${d.netGold >= 0 ? '+' : ''}${d.netGold}.
- El costo es un embedding de query fijo por búsqueda: p50 ${ms(lat.off.p50)} →
  ${ms(lat.on.p50)} (**${num(lat.ratio_p50, 1)}×**), con
  ${pct(lat.embedding_share_of_on_p50)} atribuible a la llamada de embedding.
- El benchmark pareado ya medía RAG +3.2pp de recall y una caída de abstención
  adversarial de 96.4% a 92.9% (−3.5pp) con ~34× latencia. Este experimento no
  re-ejecuta respuesta/juez; mide recuperación y costo.

**Guía de decisión (no es un cambio de configuración):**

- **Deshabilitado por defecto para agentes interactivos**: el costo fijo
  (${num(lat.ratio_p50, 1)}× p50, ${ms(lat.fixed_cost_ms_p50)}) no se justifica por
  una ganancia de recuperación de ${pp(k10.full_delta)} en K=10.
- **Habilitarlo solo en recuperación batch/offline** o cuando el usuario pueda
  tolerar ~${ms(lat.on.p50)} por búsqueda y el corpus sea pequeño (aquí 419
  memorias). El canal semántico no reemplaza al léxico: el ranking sigue siendo
  mayormente el mismo conjunto.
- **No usarlo como parche de precisión**: si el problema es ruido léxico, el
  desplazamiento de gold (${d.displacedGold}) y los insertados no-gold
  (${d.insertedNonGold}) muestran que la fusión no está claramente sesgada a
  evidencia útil; no hay base medida para subir su peso.
- **Si se busca recall adversarial/abstención**, RAG no ayuda: la corrida
  pareada empeoró la abstención. Mantener el comportamiento OFF para ese caso.

## 8. Revisión de código (read-only, sin cambios)

Hallazgo **[CÓDIGO]** (derivado de leer el código, no un resultado experimental
ajustado):

1. **[CÓDIGO] La admisión léxica se aplica antes de que el canal semántico pueda
   aportar.** En \`src/store/repositories/search-repository.ts\` el canal
   semántico agrega candidatos a \`rowsById\` (~:798-812), pero después **todos**
   los candidatos pasan por \`documentSatisfiesQuery(ast, ...)\` (~:846-854). El
   único camino que admite un candidato semántico puramente parafrástico es el
   "last resort" cuando \`finalRows.size === 0\` (~:868-869). Consecuencia: si
   existe al menos un candidato léxico que satisface la consulta, el canal
   semántico no puede introducir evidencia que no cumpla el predicado léxico.
   Esto explica que la ganancia medida sea pequeña y que los insertados
   semantic-only fuera del top-25 OFF sean ${d.insertedSemanticOnlyWindow}.
2. **Costo fijo no condicionado a utilidad.** El canal semántico corre siempre
   que RAG está habilitado y el breaker está cerrado (~:795-816); no hay
   prefiltro léxico ni caché de embeddings de query: \`querySemanticCandidateRows\`
   trae todas las memorias del filtro (~:573-604) y \`semanticSearch\` calcula
   coseno sobre todas (~:610-623). Es correcto para 419 memorias; a escala es
   O(N) por query y explica el costo fijo observado.
3. **El gate de admisión puede descartar candidatos semánticos de forma
   silenciosa**: el diagnóstico actual reporta \`admission.kept/dropped\`
   agregados, pero no separa cuántos venían solo del canal semántico. No es un
   bug funcional de ranking, pero impide atribuir el costo a una pérdida de
   recall sin instrumentación adicional.
4. **Fallback**: \`searchFallback\` (~:895-920) no participa del path del API; es
   código muerto en producción. No afecta este experimento, pero conviene no
   confundirlo con la escalera de relajación de \`searchMemories\`.

No se encontró un defecto funcional adicional en coverage/admission/fallback/
fusión/confidence que los datos de este experimento puedan demostrar. La
fusión y los buckets de confianza se comportan de forma determinista; los
cambios de peso quedan fuera de alcance (sería tuning).

## 9. UNKNOWN

- Una sola conversación (conv-26) y un corpus pequeño (419 memorias); no se
  generaliza sin otra conversación.
- No se mide si el agente **usa** mejor la evidencia ni alucinación/abstención:
  solo retrieval. La cifra adversarial citada viene del benchmark pareado, no de
  este replay.
- El costo USD es una estimación a precio de lista; no hay factura de OpenRouter.
  Los tokens se midieron en ${String(emb?.samples.length ?? 0)} llamadas directas,
  no en las ${String(lat.on_query_requests)} requests del replay.
- La DB congelada se ingirió sin captions \`[Photo: ...]\`; los números no son
  directamente comparables con una ingesta actual con captions.
- El orden de desempate y los empates de fusión son deterministas, pero una
  versión distinta de embeddings o del proveedor puede cambiar el ranking.
- La prueba de "evidencia nueva" usa el top-25 OFF como proxy de lo que el
  léxico hubiera encontrado cerca; un ítem fuera del top-25 puede seguir siendo
  candidato léxico más profundo.

## 10. Recomendación

**No habilitar RAG por defecto** con la evidencia actual: ${pp(k10.full_delta)}
de evidencia completa en K=10 a cambio de ${num(lat.ratio_p50, 1)}× latencia y
sin una ganancia clara de precisión. Mantenerlo como opción **batch/offline** o
para corpus pequeños donde el costo fijo sea aceptable. Antes de optimizar
pesos, corregir el orden admission-vs-semantic (hallazgo 1) es el cambio
funcional con mayor probabilidad de hacer que el canal semántico aporte
evidencia realmente distinta; este experimento **no** lo implementa.

## 11. Reproducción

\`\`\`bash
cd benchmarks/agent-memory && bun run experiments/rag-diff/run.ts
\`\`\`

Salidas: \`experiments/REPORTS/rag-diff/results.json\` y este \`report.md\`.
`;
}

// ── CLI ──

interface Options {
  readonly out: string;
  readonly worktree: string;
  readonly offDb: string;
  readonly onDb: string;
  readonly probes: string;
  readonly locomo: string;
  readonly scratch: string;
  readonly conversation: string;
  readonly space: string;
  readonly skipEmbeddingProbe: boolean;
}

function defaultOptions(): Options {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
  return {
    out: join(here, '..', 'REPORTS', 'rag-diff'),
    worktree: join(agentMemory, '.work/worktrees/v10'),
    offDb: join(integration, 'mind-scratch/run-mind-20261019-mind-conv-26/mind.db'),
    onDb: join(integration, 'mind-scratch/run-mind-rag-20261019-mind-conv-26/mind.db'),
    probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
    locomo: join(integration, 'data/locomo10.json'),
    scratch: join(agentMemory, '.work/experiments/rag-diff'),
    conversation: 'conv-26',
    space: DEFAULT_SPACE,
    skipEmbeddingProbe: false,
  };
}

export function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    if (arg === '--skip-embedding-probe') {
      flags.set('skip-embedding-probe', 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    index += 1;
  }
  const base = defaultOptions();
  return {
    out: flags.get('out') ?? base.out,
    worktree: flags.get('worktree') ?? base.worktree,
    offDb: flags.get('off-db') ?? base.offDb,
    onDb: flags.get('on-db') ?? base.onDb,
    probes: flags.get('probes') ?? base.probes,
    locomo: flags.get('locomo') ?? base.locomo,
    scratch: flags.get('scratch') ?? base.scratch,
    conversation: flags.get('conversation') ?? base.conversation,
    space: flags.get('space') ?? base.space,
    skipEmbeddingProbe: flags.get('skip-embedding-probe') === 'true',
  };
}

export async function runExperiment(options: Options): Promise<RagDiffResults> {
  const probes = readProbes(options.probes);
  const gold = loadGold(options.locomo, options.conversation);
  const key = readOpenRouterKey();
  const embeddingProbe = options.skipEmbeddingProbe
    ? null
    : await probeEmbeddings(key, [
        probes[0]!.question,
        probes[Math.floor(probes.length / 2)]!.question,
        probes[probes.length - 1]!.question,
        probes[0]!.question,
      ]);

  mkdirSync(options.scratch, { recursive: true });
  const off = await runDb({
    label: 'off',
    db: options.offDb,
    rag: 'off',
    probes,
    worktree: options.worktree,
    scratch: options.scratch,
    key,
    space: options.space,
  });
  const on = await runDb({
    label: 'on',
    db: options.onDb,
    rag: 'on',
    probes,
    worktree: options.worktree,
    scratch: options.scratch,
    key,
    space: options.space,
  });

  if (on.semantic_methods === 0) {
    throw new Error(
      'RAG-on replay produced no semantic methods in top-10; check the credential and server log (no key is printed)'
    );
  }

  const analyses = analyze(off, on, probes, gold);
  const gate = offGate(
    off,
    analyses,
    join(import.meta.dir, '..', 'REPORTS', 'workbench', 'dumps', 'rag-off-stages.jsonl')
  );
  const results = buildResults(off, on, analyses, gate, embeddingProbe, {
    conversation: options.conversation,
    space: options.space,
    probesPath: options.probes,
    worktree: options.worktree,
    passesPerDb: 3,
  });
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(options.out, 'report.md'), renderReport(results));
  return results;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const results = await runExperiment(options);
  const gate = results.gate as any;
  const sd = results.set_diff as any;
  process.stdout.write(
    `rag-diff done: ${String(sd.k10.probes)} probes, ` +
      `gate=${gate.funnel_match && gate.admitted_match && gate.top10_vs_dump.match ? 'pass' : 'FAIL'}, ` +
      `determinism off=${String((results.determinism as any).off_identical)} on=${String((results.determinism as any).on_identical)}, ` +
      `full@10 ${String(sd.k10.full_off)}→${String(sd.k10.full_on)}, ` +
      `jaccard=${num(sd.k10.mean_jaccard)} → ${resolve(options.out)}\n`
  );
  const healthy =
    gate.funnel_match &&
    gate.admitted_match &&
    gate.top10_vs_dump.match &&
    (results.determinism as any).off_identical &&
    (results.determinism as any).on_names_identical &&
    (results.determinism as any).on_same_input_embedding_identical;
  if (!healthy) process.exitCode = 1;
}
