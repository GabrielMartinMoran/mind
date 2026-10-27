#!/usr/bin/env bun
// ── Search benchmark harness (opt-in; NOT part of `bun test`) ──
//
// Measures search latency and per-channel telemetry over the committed v2
// fixture corpus (`--suite fixture`) or a deterministic synthetic corpus
// (`--suite scalability`), plus write-path timings, DB/index size and process
// memory. Committed artifacts are AGGREGATE SUMMARIES only; raw dumps land under
// /tmp/opencode/search-optimization/.
//
// Usage:
//   bun run scripts/bench-search.ts --suite fixture [--reps 50] [--warmup 5]
//   bun run scripts/bench-search.ts --suite scalability --corpus 1k|10k|50k|100k
//       [--allow-heavy] [--reps N] [--warmup W] [--classes a,b] [--out file.json]
//
// 50k / 100k corpora require `--allow-heavy`. A time budget (`--budget-ms`,
// default 300000) aborts the latency pass cleanly and marks the report aborted.

// Deterministic and offline: force RAG off BEFORE any module that reads CONFIG
// at import time is loaded (config.ts snapshots MIND_RAG on first load). ESM
// hoists static imports, so an app/config module imported statically below would
// load before this assignment and capture RAG-enabled config. The app modules
// are therefore loaded through a top-level `await import(...)` after the
// assignment (mirrors scripts/search-eval.ts). Node builtins are safe statically.
process.env.MIND_RAG = 'false';

import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { Database } from 'bun:sqlite';

import type { MindStore } from '../src/store/mind-store';
import type { SearchDiagnostics } from '../src/store/repositories/search-repository';
import type { CorpusDoc } from '../test/search-eval/ground-truth';
import type { CaseParams, EvalCase } from '../test/search-eval/types';

// Loaded only after the MIND_RAG assignment above; a static import would be
// hoisted above it and snapshot RAG-enabled config. Top-level await keeps the
// exported helpers below synchronous for the structural smoke test.
const { setSearchDiagnosticsSink } = await import('../src/store/repositories/search-repository');
const { createSqliteStore } = await import('../src/store/sqlite-store');
const { buildV2Cases } = await import('../test/search-eval/cases.expanded');
const { V2_CORPUS } = await import('../test/search-eval/corpus.expanded');

export const BENCH_TMP_DIR = '/tmp/opencode/search-optimization';

// ── Statistics ──

export interface Summary {
  n: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Linear-interpolated percentile over an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = (p / 100) * (sortedAsc.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sortedAsc[low]!;
  return sortedAsc[low]! + (sortedAsc[high]! - sortedAsc[low]!) * (index - low);
}

/** Mean/min/max and p50/p95/p99 for a set of durations (ms). */
export function summarize(durations: number[]): Summary {
  if (durations.length === 0) {
    return { n: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// ── Query classification ──

/**
 * Deterministic label for a v2 case, used to group latency. Filter cases (any
 * space/tag/tier parameter) collapse into `filter`; hard irrelevant negatives
 * (N0) become `irrelevant`; everything else keeps its case type.
 */
export function classOf(evalCase: EvalCase): string {
  if (
    evalCase.params.space !== undefined ||
    evalCase.params.tag !== undefined ||
    evalCase.params.tier !== undefined
  ) {
    return 'filter';
  }
  if (evalCase.type === 'negative') return evalCase.level === 'N0' ? 'irrelevant' : 'negative';
  return evalCase.type;
}

export interface BenchQuery {
  id: string;
  query: string;
  params: CaseParams;
  class: string;
}

/** Fixture-suite queries derived from the committed v2 cases. */
export function buildFixtureBenchQueries(): BenchQuery[] {
  return buildV2Cases().map(evalCase => ({
    id: evalCase.id,
    query: evalCase.query,
    params: evalCase.params,
    class: classOf(evalCase),
  }));
}

/** Requested classes include the fuzzy-specific and trigram-specific groups. */
export const FUZZY_CLASSES = [
  'typo',
  'first3typo',
  'transposition',
  'insertion',
  'deletion',
  'substring',
];
export const TRIGRAM_CLASSES = ['substring'];

// ── Scalability corpus generation (deterministic, seeded, Zipf-like) ──

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ES_WORDS = [
  'proyecto',
  'registro',
  'memoria',
  'configuracion',
  'sistema',
  'agente',
  'documento',
  'informe',
  'equipo',
  'sesion',
  'usuario',
  'servicio',
  'proceso',
  'archivo',
  'revision',
  'detalle',
  'contexto',
  'modelo',
  'resultado',
  'analisis',
  'desarrollo',
  'prueba',
  'entorno',
  'recurso',
  'objetivo',
  'decision',
  'patron',
  'estructura',
  'consulta',
  'respuesta',
  'control',
  'gestion',
  'flujo',
  'cambio',
  'historial',
  'version',
  'modulo',
  'componente',
  'interfaz',
  'funcion',
];
const EN_WORDS = [
  'project',
  'record',
  'memory',
  'configuration',
  'system',
  'agent',
  'document',
  'report',
  'team',
  'session',
  'user',
  'service',
  'process',
  'file',
  'review',
  'detail',
  'context',
  'model',
  'result',
  'analysis',
  'development',
  'test',
  'environment',
  'resource',
  'objective',
  'decision',
  'pattern',
  'structure',
  'query',
  'response',
  'control',
  'management',
  'flow',
  'change',
  'history',
  'version',
  'module',
  'component',
  'interface',
  'function',
];
const ACCENTED_WORDS = [
  'configuración',
  'puntuación',
  'acción',
  'reacción',
  'corazón',
  'canción',
  'año',
  'caña',
  'señal',
  'bilingüe',
  'café',
  'información',
  'aplicación',
  'sesión',
  'decisión',
  'gestión',
  'análisis',
  'método',
  'módulo',
  'código',
];
const IDENTIFIERS = [
  'handleSearchResults',
  'parseQueryAstNotation',
  'search_fusion_weights',
  'ranking_metrics_v2',
  'multi-token-query-builder',
  'tokenBorderColor',
  'deep_link_router',
  'feat-026-cache',
  'rb26-openrouter',
  'MIND_SEARCH_DIAG',
  'neural-map-graph',
  'spa-url-contract',
];

// Syllable pools for a large, deterministic synthetic vocabulary. A wide
// synthetic tail mixed with the small real-word base avoids the pathological
// repetition of a fixed short word list while keeping Zipf-like skew (a few
// very common terms plus a long rare tail).
const SYLLABLES_A = [
  'ba',
  'ca',
  'da',
  'fe',
  'ga',
  'la',
  'ma',
  'na',
  'pa',
  'ra',
  'sa',
  'ta',
  'vi',
  'zo',
  'pro',
  'con',
  're',
  'de',
  'in',
  'ex',
  'trans',
  'multi',
  'sub',
  'inter',
  'para',
  'anti',
  'meta',
  'micro',
  'macro',
  'poly',
];
const SYLLABLES_B = [
  'ran',
  'len',
  'tor',
  'mar',
  'bin',
  'del',
  'nov',
  'key',
  'sys',
  'nid',
  'pol',
  'ver',
  'tas',
  'lum',
  'gra',
  'fen',
  'dor',
  'cas',
  'mel',
  'tin',
  'ston',
  'ford',
  'berg',
  'wick',
  'dale',
  'holm',
  'gard',
  'mont',
  'ville',
];
const SYLLABLE_TAILS = [
  'a',
  'e',
  'i',
  'o',
  'u',
  'is',
  'os',
  'al',
  'er',
  'or',
  'ia',
  'io',
  'en',
  'ar',
  'us',
  'ium',
  'ance',
  'ity',
  'ology',
  'ation',
];

/** One deterministic word-like token from the syllable pools. */
function syntheticWord(rng: () => number): string {
  const a = SYLLABLES_A[Math.floor(rng() * SYLLABLES_A.length)]!;
  const b = SYLLABLES_B[Math.floor(rng() * SYLLABLES_B.length)]!;
  const t = SYLLABLE_TAILS[Math.floor(rng() * SYLLABLE_TAILS.length)]!;
  return `${a}${b}${t}`;
}

/** Deterministic synthetic vocabulary of (up to) `count` distinct word-like tokens. */
export function buildSyntheticVocabulary(count: number, seed: number): string[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const words = new Set<string>();
  let guard = 0;
  while (words.size < count && guard < count * 40) {
    guard += 1;
    const word = syntheticWord(rng);
    if (word.length >= 4) words.add(word);
  }
  return [...words];
}

/** Target document sizes (characters) for the diverse synthetic corpus. */
const DOC_LENGTH_TARGETS = [300, 1000, 2000];

function pick(rng: () => number, vocab: string[]): string {
  // Zipf-like skew: squaring a uniform biases toward low indices (common words).
  const index = Math.floor(rng() * rng() * vocab.length);
  return vocab[Math.min(index, vocab.length - 1)]!;
}

/** Zipf-like pick with a configurable skew exponent (`power` > 1 favours the head). */
function pickSkew(rng: () => number, vocab: string[], power: number): string {
  const index = Math.floor(Math.pow(rng(), power) * vocab.length);
  return vocab[Math.min(index, vocab.length - 1)]!;
}

/**
 * Deterministic synthetic corpus: a large Zipf-like synthetic vocabulary mixed
 * with a small real ES/EN/accented base and identifiers, varied document lengths
 * (300/1000/2000 target characters), and one unique rare token per doc (buried
 * mid-document) so long-memory recall is measurable. Avoids the repetition of a
 * tiny fixed word list.
 */
export function generateCorpus(size: number, seed = 20261017): CorpusDoc[] {
  const rng = mulberry32(seed);
  const synthetic = buildSyntheticVocabulary(6000, seed);
  const spaces = ['bench/alpha', 'bench/beta', 'bench/gamma'];
  const docs: CorpusDoc[] = [];
  for (let index = 0; index < size; index += 1) {
    const space = spaces[Math.floor(rng() * spaces.length)]!;
    const targetLength = DOC_LENGTH_TARGETS[Math.floor(rng() * rng() * DOC_LENGTH_TARGETS.length)]!;
    const parts: string[] = [];
    let chars = 0;
    while (chars < targetLength) {
      const roll = rng();
      let word: string;
      if (roll < 0.4) word = pick(rng, ES_WORDS);
      else if (roll < 0.64) word = pick(rng, EN_WORDS);
      else if (roll < 0.74) word = pick(rng, ACCENTED_WORDS);
      else if (roll < 0.84) word = pickSkew(rng, synthetic, 3);
      else if (roll < 0.88) word = pick(rng, IDENTIFIERS);
      else word = pickSkew(rng, synthetic, 1.5);
      parts.push(word);
      chars += word.length + 1;
    }
    parts.splice(Math.floor(parts.length / 2), 0, `rare${index.toString(36)}`);
    const name = `${pick(rng, ES_WORDS)}-${pick(rng, EN_WORDS)}-${index}`;
    docs.push({
      space,
      name,
      content: parts.join(' '),
      tier: (1 + Math.floor(rng() * 3)) as 1 | 2 | 3,
      tags: ['type:bench'],
    });
  }
  return docs;
}

/** A small, deterministic query set spanning the latency classes. */
export function buildScalabilityQueries(corpus: CorpusDoc[], samples = 8): BenchQuery[] {
  const queries: BenchQuery[] = [];
  const step = Math.max(1, Math.floor(corpus.length / samples));
  for (let index = 0; index < corpus.length; index += step) {
    const doc = corpus[index]!;
    const tokens = doc.name.split(/[^a-zA-Z0-9]+/).filter(token => token.length >= 4);
    const anchor = tokens[0];
    if (!anchor) continue;
    queries.push({ id: `sc-exact-${index}`, query: anchor, params: {}, class: 'exact' });
    queries.push({
      id: `sc-prefix-${index}`,
      query: `${anchor.slice(0, 4)}*`,
      params: {},
      class: 'prefix',
    });
    const mid = anchor.slice(1, Math.max(2, anchor.length - 1));
    if (mid.length >= 3) {
      queries.push({
        id: `sc-substring-${index}`,
        query: mid.slice(0, 6),
        params: {},
        class: 'substring',
      });
    }
    const last = anchor[anchor.length - 1];
    queries.push({
      id: `sc-typo-${index}`,
      query: `${anchor.slice(0, -1)}${last === 'a' ? 'o' : 'a'}`,
      params: {},
      class: 'typo',
    });
    const second = tokens[1];
    if (second) {
      queries.push({
        id: `sc-and-${index}`,
        query: `${anchor} ${second}`,
        params: {},
        class: 'and',
      });
      queries.push({
        id: `sc-or-${index}`,
        query: `${anchor} OR ${second}`,
        params: {},
        class: 'or',
      });
    }
    queries.push({
      id: `sc-filter-${index}`,
      query: anchor,
      params: { space: doc.space },
      class: 'filter',
    });
    queries.push({
      id: `sc-neg-${index}`,
      query: `zzzq${index} inexistentetoken`,
      params: {},
      class: 'irrelevant',
    });
    if (queries.length >= samples * 8) break;
  }
  return queries;
}

// ── Telemetry aggregation (counts/timings only; never content) ──

export interface ChannelTelemetry {
  channel: string;
  candidates: number;
  ms_total: number;
  calls: number;
}

export interface Telemetry {
  per_channel: ChannelTelemetry[];
  fuzzy_expansions: number;
  admission_kept: number;
  admission_dropped: number;
  total_candidates: number;
}

function emptyTelemetry(): Telemetry {
  return {
    per_channel: [],
    fuzzy_expansions: 0,
    admission_kept: 0,
    admission_dropped: 0,
    total_candidates: 0,
  };
}

function accumulateTelemetry(telemetry: Telemetry, diagnostics: SearchDiagnostics): void {
  for (const channel of diagnostics.channels) {
    let entry = telemetry.per_channel.find(candidate => candidate.channel === channel.channel);
    if (!entry) {
      entry = { channel: channel.channel, candidates: 0, ms_total: 0, calls: 0 };
      telemetry.per_channel.push(entry);
    }
    entry.candidates += channel.candidates;
    entry.ms_total += channel.ms;
    entry.calls += 1;
  }
  telemetry.fuzzy_expansions += diagnostics.fuzzy_expansions;
  telemetry.admission_kept += diagnostics.admission.kept;
  telemetry.admission_dropped += diagnostics.admission.dropped;
  telemetry.total_candidates += diagnostics.total_candidates;
}

// ── Latency measurement ──

export interface LatencyOptions {
  reps: number;
  warmup: number;
  budgetMs: number;
}

export interface LatencyResult {
  by_class: Record<string, Summary>;
  fuzzy_specific: Summary;
  trigram_specific: Summary;
  overall: Summary;
  telemetry: Telemetry;
  measured: number;
  aborted: boolean;
}

function filterOf(params: CaseParams): { space?: string; tier?: CaseParams['tier']; tag?: string } {
  return { space: params.space, tier: params.tier, tag: params.tag };
}

export async function measureLatency(
  store: MindStore,
  queries: BenchQuery[],
  options: LatencyOptions
): Promise<LatencyResult> {
  const { reps, warmup, budgetMs } = options;
  const durationsByClass = new Map<string, number[]>();
  const all: number[] = [];
  const telemetry = emptyTelemetry();
  const startedAt = performance.now();
  let aborted = false;
  let measured = 0;
  let lastDiagnostics: SearchDiagnostics | null = null;

  setSearchDiagnosticsSink(diagnostics => {
    lastDiagnostics = diagnostics;
  });
  try {
    for (const benchQuery of queries) {
      if (budgetMs > 0 && performance.now() - startedAt > budgetMs) {
        aborted = true;
        break;
      }
      for (let run = 0; run < warmup; run += 1) {
        await store.search(benchQuery.query, filterOf(benchQuery.params));
      }
      const bucket = durationsByClass.get(benchQuery.class) ?? [];
      for (let run = 0; run < reps; run += 1) {
        if (budgetMs > 0 && performance.now() - startedAt > budgetMs) {
          aborted = true;
          break;
        }
        lastDiagnostics = null;
        const begin = performance.now();
        await store.search(benchQuery.query, filterOf(benchQuery.params));
        const elapsed = performance.now() - begin;
        bucket.push(elapsed);
        all.push(elapsed);
        measured += 1;
        if (run === 0 && lastDiagnostics) accumulateTelemetry(telemetry, lastDiagnostics);
      }
      durationsByClass.set(benchQuery.class, bucket);
      if (aborted) break;
    }
  } finally {
    setSearchDiagnosticsSink(null);
  }

  const byClass: Record<string, Summary> = {};
  for (const key of [...durationsByClass.keys()].sort()) {
    byClass[key] = summarize(durationsByClass.get(key)!);
  }

  const fuzzy = FUZZY_CLASSES.flatMap(key => durationsByClass.get(key) ?? []);
  const trigram = TRIGRAM_CLASSES.flatMap(key => durationsByClass.get(key) ?? []);
  telemetry.per_channel.sort((a, b) =>
    a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
  );

  return {
    by_class: byClass,
    fuzzy_specific: summarize(fuzzy),
    trigram_specific: summarize(trigram),
    overall: summarize(all),
    telemetry,
    measured,
    aborted,
  };
}

// ── Write path ──

export interface WritePathResult {
  add: Summary;
  update: Summary;
  delete: Summary;
  count: number;
}

/** add / update / delete timings on the given (already-open) store. */
export async function measureWritePathInto(
  store: MindStore,
  count = 200
): Promise<WritePathResult> {
  const add: number[] = [];
  const update: number[] = [];
  const remove: number[] = [];
  store.createSpace('bench/writes', 'bench write space', ['type:bench']);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const begin = performance.now();
    const memory = await store.addMemory('bench/writes', `w-${index}`, `contenido base ${index}`, {
      tags: ['type:bench'],
      tier: 2,
    });
    add.push(performance.now() - begin);
    ids.push(memory.id);
  }
  for (const id of ids) {
    const begin = performance.now();
    await store.updateMemory(id, { content: `contenido actualizado ${id}` });
    update.push(performance.now() - begin);
  }
  for (const id of ids) {
    const begin = performance.now();
    store.deleteMemory(id);
    remove.push(performance.now() - begin);
  }
  return { add: summarize(add), update: summarize(update), delete: summarize(remove), count };
}

/** add / update / delete timings on a fresh throwaway store. */
export async function measureWritePath(count = 200): Promise<WritePathResult> {
  const dbPath = join(BENCH_TMP_DIR, `bench-writes-${Date.now()}.db`);
  const store = createSqliteStore(dbPath);
  try {
    return await measureWritePathInto(store, count);
  } finally {
    store.close();
    cleanupDb(dbPath);
  }
}

// ── DB / index size ──

export interface PageStats {
  bytes: number;
  page_count: number;
  page_size: number;
  freelist_count: number;
}

export interface DbSizeResult {
  with_trigram: PageStats;
  without_trigram: PageStats;
  trigram_overhead_bytes: number;
  trigram_overhead_ratio: number | null;
}

function readPragma(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  if (!row) return 0;
  const first = Object.values(row)[0];
  return typeof first === 'number' ? first : 0;
}

function pageStats(path: string): PageStats {
  const db = new Database(path, { readonly: true });
  try {
    const pageCount = readPragma(db, 'page_count');
    const pageSize = readPragma(db, 'page_size');
    const freelist = readPragma(db, 'freelist_count');
    return {
      bytes: pageCount * pageSize,
      page_count: pageCount,
      page_size: pageSize,
      freelist_count: freelist,
    };
  } finally {
    db.close();
  }
}

function vacuumInto(source: string, destination: string): void {
  const db = new Database(source);
  try {
    db.run(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

/** Compacted size with/without the trigram index (dbstat is unavailable). */
export function measureDbSize(dbPath: string): DbSizeResult {
  const withPath = `${dbPath}.vacuum-with.db`;
  removeIfExists(withPath);
  vacuumInto(dbPath, withPath);
  const withStats = pageStats(withPath);

  const strippedPath = `${dbPath}.stripped.db`;
  removeIfExists(strippedPath);
  copyFileSync(withPath, strippedPath);
  const stripped = new Database(strippedPath);
  try {
    stripped.run('DROP TABLE IF EXISTS memories_fts_trigram');
  } finally {
    stripped.close();
  }

  const withoutPath = `${dbPath}.vacuum-without.db`;
  removeIfExists(withoutPath);
  vacuumInto(strippedPath, withoutPath);
  const withoutStats = pageStats(withoutPath);

  removeIfExists(strippedPath);
  const overhead = withStats.bytes - withoutStats.bytes;
  return {
    with_trigram: withStats,
    without_trigram: withoutStats,
    trigram_overhead_bytes: overhead,
    trigram_overhead_ratio: withStats.bytes === 0 ? null : overhead / withStats.bytes,
  };
}

export function cleanupDb(dbPath: string): void {
  for (const suffix of [
    '',
    '-wal',
    '-shm',
    '.vacuum-with.db',
    '.vacuum-without.db',
    '.stripped.db',
  ]) {
    removeIfExists(dbPath + suffix);
  }
}

// The dev-only search-term dictionary was retired before the final
// consolidated schema v10 (§8bis P-A fallback), so there is no dictionary
// footprint or dictionary rebuild to measure. Open-cost measurement is covered
// by the latency suite.

// ── Determinism ──

export interface DeterminismResult {
  queries: number;
  hash: string;
}

/** Ordered-result + score hash over the query set (two runs → same hash). */
export async function measureDeterminism(
  store: MindStore,
  queries: BenchQuery[]
): Promise<DeterminismResult> {
  const lines: string[] = [];
  for (const benchQuery of queries) {
    const results = (await store.search(
      benchQuery.query,
      filterOf(benchQuery.params)
    )) as unknown as {
      space_name?: string;
      name?: string;
      score?: number;
    }[];
    // Hash on the stable public identity, never the per-run random UUID.
    lines.push(
      `${benchQuery.id}\t${results
        .map(
          entry =>
            `${entry.space_name ?? '?'}/${entry.name ?? '?'}:${
              typeof entry.score === 'number' ? entry.score.toFixed(6) : '-'
            }`
        )
        .join(',')}`
    );
  }
  return {
    queries: queries.length,
    hash: createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

// ── Memory ──

export interface MemoryResult {
  rss_before: number;
  rss_after: number;
  rss_delta: number;
  heap_used_before: number;
  heap_used_after: number;
  heap_used_delta: number;
}

// ── Seeding ──

interface SeedResult {
  store: MindStore;
  dbPath: string;
}

async function seedCorpusStore(docs: CorpusDoc[], label: string): Promise<SeedResult> {
  mkdirSync(BENCH_TMP_DIR, { recursive: true });
  const dbPath = join(BENCH_TMP_DIR, `bench-${label}-${Date.now()}.db`);
  const store = createSqliteStore(dbPath);
  const spaces = [...new Set(docs.map(doc => doc.space))].sort();
  for (const space of spaces) store.createSpace(space, `bench space ${space}`, ['type:bench']);
  for (const doc of docs) {
    await store.addMemory(doc.space, doc.name, doc.content, { tags: doc.tags, tier: doc.tier });
  }
  return { store, dbPath };
}

/** Seed a throwaway store (used by the smoke test too). */
export async function seedStore(docs: CorpusDoc[], label = 'corpus'): Promise<SeedResult> {
  return seedCorpusStore(docs, label);
}

// ── Report ──

export interface BenchReport {
  schema: 'search-bench/v1';
  suite: string;
  corpus: string;
  docs: number;
  reps: number;
  warmup: number;
  seed: number;
  latency: LatencyResult;
  write_path: WritePathResult;
  write_path_at_scale: WritePathResult;
  db_size: DbSizeResult;
  determinism: DeterminismResult;
  memory: MemoryResult;
  aborted: boolean;
}

const CORPUS_SIZES: Record<string, number> = {
  '1k': 1000,
  '10k': 10000,
  '50k': 50000,
  '100k': 100000,
};

interface Args {
  suite: string;
  corpus: string;
  reps: number;
  warmup: number;
  classes: string[] | null;
  out: string | null;
  allowHeavy: boolean;
  budgetMs: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    suite: 'fixture',
    corpus: '1k',
    reps: 50,
    warmup: 5,
    classes: null,
    out: null,
    allowHeavy: false,
    budgetMs: 300000,
    seed: 20261017,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      index += 1;
      const next = argv[index];
      if (next === undefined) throw new Error(`Missing value for ${token}`);
      return next;
    };
    switch (token) {
      case '--suite':
        args.suite = value();
        break;
      case '--corpus':
        args.corpus = value();
        break;
      case '--reps':
        args.reps = Number(value());
        break;
      case '--warmup':
        args.warmup = Number(value());
        break;
      case '--classes':
        args.classes = value()
          .split(',')
          .map(entry => entry.trim())
          .filter(Boolean);
        break;
      case '--out':
        args.out = value();
        break;
      case '--seed':
        args.seed = Number(value());
        break;
      case '--budget-ms':
        args.budgetMs = Number(value());
        break;
      case '--allow-heavy':
        args.allowHeavy = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function renderTable(report: BenchReport): string {
  const rows: string[] = [];
  const fmt = (value: number) => value.toFixed(2);
  rows.push(
    `suite=${report.suite} corpus=${report.corpus} docs=${report.docs} reps=${report.reps} warmup=${report.warmup}`
  );
  rows.push('class                 n     mean     p50     p95     p99');
  for (const key of Object.keys(report.latency.by_class)) {
    const summary = report.latency.by_class[key]!;
    rows.push(
      `${key.padEnd(20)} ${String(summary.n).padStart(4)} ${fmt(summary.mean).padStart(8)} ${fmt(
        summary.p50
      ).padStart(7)} ${fmt(summary.p95).padStart(7)} ${fmt(summary.p99).padStart(7)}`
    );
  }
  const total = report.latency.overall;
  rows.push(
    `${'TOTAL'.padEnd(20)} ${String(total.n).padStart(4)} ${fmt(total.mean).padStart(8)} ${fmt(
      total.p50
    ).padStart(7)} ${fmt(total.p95).padStart(7)} ${fmt(total.p99).padStart(7)}`
  );
  rows.push(
    `fuzzy-specific p50=${fmt(report.latency.fuzzy_specific.p50)}  trigram-specific p50=${fmt(
      report.latency.trigram_specific.p50
    )}`
  );
  rows.push('channels:');
  for (const channel of report.latency.telemetry.per_channel) {
    rows.push(
      `  ${channel.channel.padEnd(12)} candidates=${channel.candidates}  ms=${fmt(channel.ms_total)}`
    );
  }
  rows.push(
    `write-path add p50=${fmt(report.write_path.add.p50)}  update p50=${fmt(
      report.write_path.update.p50
    )}  delete p50=${fmt(report.write_path.delete.p50)} (${report.write_path.count} ops each)`
  );
  rows.push(
    `write-path@scale add p50=${fmt(report.write_path_at_scale.add.p50)}  update p50=${fmt(
      report.write_path_at_scale.update.p50
    )}  delete p50=${fmt(report.write_path_at_scale.delete.p50)} (${
      report.write_path_at_scale.count
    } ops on seeded store)`
  );
  rows.push(
    `db bytes=${report.db_size.with_trigram.bytes} trigram_overhead=${report.db_size.trigram_overhead_bytes} (${(
      (report.db_size.trigram_overhead_ratio ?? 0) * 100
    ).toFixed(1)}%)`
  );
  rows.push(
    `determinism queries=${report.determinism.queries} hash=${report.determinism.hash.slice(0, 16)}`
  );
  rows.push(
    `memory rss_delta=${report.memory.rss_delta} heap_used_delta=${report.memory.heap_used_delta}`
  );
  if (report.aborted) rows.push('ABORTED: time budget exceeded');
  return rows.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  mkdirSync(BENCH_TMP_DIR, { recursive: true });

  const docs = args.suite === 'scalability' ? CORPUS_SIZES[args.corpus] : undefined;
  if (args.suite === 'scalability') {
    if (docs === undefined) throw new Error(`Unknown --corpus ${args.corpus}`);
    if ((args.corpus === '50k' || args.corpus === '100k') && !args.allowHeavy) {
      throw new Error(`${args.corpus} requires --allow-heavy`);
    }
  }

  const memoryBefore = process.memoryUsage();
  let store: MindStore;
  let dbPath: string;
  let docCount: number;
  let queries: BenchQuery[];

  if (args.suite === 'fixture') {
    const seeded = await seedCorpusStore(V2_CORPUS, 'fixture');
    store = seeded.store;
    dbPath = seeded.dbPath;
    docCount = V2_CORPUS.length;
    queries = buildFixtureBenchQueries();
  } else {
    const corpus = generateCorpus(docs!, args.seed);
    const seeded = await seedCorpusStore(corpus, `scalability-${args.corpus}`);
    store = seeded.store;
    dbPath = seeded.dbPath;
    docCount = corpus.length;
    queries = buildScalabilityQueries(corpus);
  }

  if (args.classes) {
    const allowed = new Set(args.classes);
    queries = queries.filter(benchQuery => allowed.has(benchQuery.class));
  }

  const memoryAfterSeed = process.memoryUsage();

  const latency = await measureLatency(store, queries, {
    reps: args.reps,
    warmup: args.warmup,
    budgetMs: args.budgetMs,
  });

  const determinism = await measureDeterminism(store, queries);
  const writePathAtScale = await measureWritePathInto(store, 100);

  store.close();

  const writePath = await measureWritePath(200);
  const dbSize = measureDbSize(dbPath);
  cleanupDb(dbPath);

  const memory: MemoryResult = {
    rss_before: memoryBefore.rss,
    rss_after: memoryAfterSeed.rss,
    rss_delta: memoryAfterSeed.rss - memoryBefore.rss,
    heap_used_before: memoryBefore.heapUsed,
    heap_used_after: memoryAfterSeed.heapUsed,
    heap_used_delta: memoryAfterSeed.heapUsed - memoryBefore.heapUsed,
  };

  const report: BenchReport = {
    schema: 'search-bench/v1',
    suite: args.suite,
    corpus: args.corpus,
    docs: docCount,
    reps: args.reps,
    warmup: args.warmup,
    seed: args.seed,
    latency,
    write_path: writePath,
    write_path_at_scale: writePathAtScale,
    db_size: dbSize,
    determinism,
    memory,
    aborted: latency.aborted,
  };

  const json = JSON.stringify(report, null, 2) + '\n';
  mkdirSync(join(BENCH_TMP_DIR, 'raw'), { recursive: true });
  const rawPath = join(
    BENCH_TMP_DIR,
    'raw',
    `bench-${args.suite}-${args.corpus}-${Date.now()}.json`
  );
  await Bun.write(rawPath, json);
  if (args.out) await Bun.write(args.out, json);

  console.log(renderTable(report));
  console.log(`\nraw: ${rawPath}`);
  if (args.out) console.log(`out: ${args.out}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
