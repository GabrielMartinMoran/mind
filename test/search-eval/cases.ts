// ── Labeled evaluation cases for the fixture search suite ──
//
// Cases are built from the committed corpus. Two sources:
//   1. Curated cases that mirror specific real query shapes (realShape: true),
//      taken from the usage evidence file.
//   2. Deterministic generators over the corpus (name/anchor/prefix/…), plus a
//      curated hand-written set for hard/extreme (N4) cases.
//
// Every case's `expected` labels are explicit: they are derived by scanning the
// committed corpus with a declared `MatchSpec` (see ground-truth.ts). Nothing
// here depends on the engine under evaluation.

import { FIXTURE_CORPUS, FIXTURE_SPACES } from './corpus';
import { deriveExpected, type MatchSpec } from './ground-truth';
import { refOf } from './refs';
import type { CaseLevel, CaseOrigin, CaseParams, CaseType, EvalCase } from './types';

const OR_SPLIT = /\s+OR\s+/i;

/** Minimum length for the longest name token to be used as a single-token anchor. */
const MIN_ANCHOR_TOKEN_LENGTH = 5;

/** Build a canonical corpus ref `space::name`. */
function ref(space: string, name: string): string {
  return refOf(space, name);
}

/** Split a query into significant tokens (drops quotes, wildcards, operators). */
function significantTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map(part => part.replace(/[*"]/g, '').trim())
    .filter(part => part.length > 0 && !/^(OR|AND|NOT)$/i.test(part));
}

/** Build an "any of these substrings" spec from an `A OR B` query. */
function orSpec(query: string): MatchSpec {
  const operands = query
    .split(OR_SPLIT)
    .map(part => part.replace(/"/g, '').trim())
    .filter(Boolean);
  return { kind: 'any', tokens: operands };
}

interface CaseSeed {
  id: string;
  query: string;
  params?: CaseParams;
  level: CaseLevel;
  origin: CaseOrigin;
  type: CaseType;
  realShape?: boolean;
  notes?: string;
  /** Ground-truth spec. When omitted, inferred from the query shape. */
  spec?: MatchSpec;
  /**
   * Explicit curated labels. Used when the intended target cannot be derived
   * mechanically (e.g. a semantic relation like `noche`/`nocturno`); the case
   * intent IS the label. Overrides `spec`.
   */
  expected?: string[];
}

function defaultSpec(seed: CaseSeed): MatchSpec {
  if (seed.spec) return seed.spec;
  if (OR_SPLIT.test(seed.query)) return orSpec(seed.query);
  return { kind: 'all', tokens: significantTokens(seed.query) };
}

function buildCase(seed: CaseSeed): EvalCase {
  const params = seed.params ?? {};
  const spec = defaultSpec(seed);
  return {
    id: seed.id,
    query: seed.query,
    params,
    expected: seed.expected ?? deriveExpected(FIXTURE_CORPUS, spec, params),
    level: seed.level,
    origin: seed.origin,
    type: seed.type,
    realShape: seed.realShape,
    notes: seed.notes,
  };
}

// ── 1. Curated real-shape cases (≥40) ──
// Queries copied from the real usage evidence file; mirrored by corpus docs.

const REAL_SHAPE_SEEDS: CaseSeed[] = [
  // TTRPG sessions
  {
    id: 'rs-ttrpg-drex',
    query: 'Drex Berull statblock ARCANA rango 2',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-arcana-reglas',
    query: 'ARCANA reglas nuevas criaturas rango tier PPF statblock',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-ogros-ppf',
    query: 'ogros risco nombres PPF finales rango 2 statblock',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-sesion16-combate',
    query: 'sesion 16 grupo nivel combate PJs nivel',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: the session-16 encounter; "grupo"/"combate" not literally co-present',
    expected: [ref(FIXTURE_SPACES.ttrpg, 'encuentro-s16-cinco-lobos-balance-pa')],
  },
  {
    id: 'rs-ttrpg-prep-refugio',
    query: 'sesion-16-prep-refugio-paladines-vigia',
    level: 'N1',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-encuentro-lobos',
    query: 'encuentro-s16-cinco-lobos-balance-pa',
    level: 'N1',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-sesion16-resumen',
    query: 'Sesión 16 resumen PP puntos progreso formato transcripción',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-prep-sesion17',
    query: 'preparación sesión 17 refugio Garuda Puntaroca progreso de sesión 16',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-deuda-profeta',
    query: 'la-deuda-del-profeta-reemplaza-lobos-viaje-puntaroca',
    level: 'N1',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-comitiva',
    query: 'comitiva Serelia Garuda refugiados salida Puntaroca sesión 17',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-mohabilbo',
    query: 'Mohabilbo ogros risco ARCANA Guerrero statblock',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-deuda-larga',
    query: 'La Deuda del Profeta ogros R2 R1 Garuda Serelia PA encuentro Sesión 16',
    level: 'N4',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: The Deuda del Profeta / Mohabilbo encounter thread',
    expected: [ref(FIXTURE_SPACES.ttrpg, 'la-deuda-del-profeta')],
  },
  {
    id: 'rs-ttrpg-hondonada',
    query: 'Hondonada Peaje tesoro ogros botin campamento',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-ttrpg-xan-dartz',
    query: 'Xan Faelor Dartz Faro Puerto Bruma ataque noche viajeros Hoar',
    level: 'N4',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: the Xan/Dartz night-attack scene; "noche" is semantically "nocturno"',
    expected: [ref(FIXTURE_SPACES.ttrpg, 'xan-faelor-dartz')],
  },
  {
    id: 'rs-ttrpg-salud-temporal',
    query: 'temporal HP OR temp hp OR salud temporal',
    level: 'N3',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  // Foundry / module work
  {
    id: 'rs-foundry-token-color',
    query: 'foundry token color',
    level: 'N1',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-border-selector',
    query: 'token border color selector highlight',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-configure-sheet',
    query: 'token color border configureSheet',
    level: 'N2',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-animacion',
    query: 'animación temp bar animateBars',
    level: 'N3',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-intercepts',
    query: 'temp hp bar animation intercept _drawBar',
    level: 'N4',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-uiscale',
    query: 'token bar temp refresh uiScale _drawBar',
    level: 'N4',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-border-or',
    query: 'tokenBorderColor OR "color del borde" OR "border color"',
    level: 'N3',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-foundry-t1-qa',
    query: 'token color T1 QA forceReload offsets',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-size-or',
    query: 'token size OR flag OR arcana flag',
    level: 'N3',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-foundry-creature-sheet',
    query: 'creature size token configureSheet',
    level: 'N2',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-canonical',
    query: 'canonical creature sizes',
    level: 'N1',
    origin: 'emulated',
    type: 'phrase',
    realShape: true,
  },
  {
    id: 'rs-foundry-status-exclusivity',
    query: 'foundry status effects exclusivity fatigue arcana actor',
    level: 'N4',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-status-cefiro',
    query: 'status effects buffs cartas Céfiro bardo inspiración',
    level: 'N4',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-v14-or',
    query: 'foundry v14 OR module OR system',
    level: 'N2',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-foundry-detach-or',
    query: 'detach OR detachable OR popout',
    level: 'N2',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-foundry-fullbleed',
    query: 'detach fullbleed full-bleed',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-foundry-temp-health',
    query: 'temp HP token bar health',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: the temp-HP token bar; "health" is Spanish "salud" in the corpus',
    expected: [ref(FIXTURE_SPACES.foundry, 'token-color-temp-hp')],
  },
  {
    id: 'rs-foundry-arist',
    query: 'ArcanaToken construction TypeError private fields',
    level: 'N3',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-foundry-sheet-render',
    query: 'sheet render iframe forceReload',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  // Embeddings / RAG
  {
    id: 'rs-rag-or',
    query: 'embedding OR rag OR openrouter OR openai',
    level: 'N2',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-rag-or2',
    query: 'openai OR semantic or vector',
    level: 'N2',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-rag-provider',
    query: 'embedding OR OpenRouter OR RAG provider',
    level: 'N2',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-rag-rb26',
    query: 'rb26 openrouter',
    level: 'N1',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-rag-rebound-or',
    query: 'rebound 26 OR rb26 OR openrouter-only OR anthropic removal',
    level: 'N3',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  // Report / cache / infra
  {
    id: 'rs-report-performance',
    query: 'large report performance diagnosis',
    level: 'N1',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-report-endpoint-or',
    query: 'report endpoint project id validation slug OR "005-large-report-performance"',
    level: 'N4',
    origin: 'emulated',
    type: 'or',
    realShape: true,
    notes:
      'intent: the report-endpoint validation memory; the engine currently throws on the embedded quotes (errored baseline finding)',
    expected: [ref(FIXTURE_SPACES.project, 'report-endpoint-validation')],
  },
  {
    id: 'rs-report-task2',
    query: '005 large-report performance task 2 FEAT-027 lean payloads',
    level: 'N4',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: the large-report performance memory ("005" not present verbatim)',
    expected: [ref(FIXTURE_SPACES.project, 'large-report-performance')],
  },
  {
    id: 'rs-cache-or',
    query: 'cache fix OR cache-fix OR FEAT-023 OR cache scope',
    level: 'N3',
    origin: 'emulated',
    type: 'or',
    realShape: true,
  },
  {
    id: 'rs-cache-analyzed',
    query: 'cache analyzed_file purity-api',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-test-isolation',
    query: 'integration test isolation cleanup analytics',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
    notes: 'intent: integration-test isolation; corpus spells it "analíticos", not "analytics"',
    expected: [ref(FIXTURE_SPACES.project, 'integration-test-isolation')],
  },
  {
    id: 'rs-vitest-parallel',
    query: 'vitest parallel test database',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-build-artifacts',
    query: 'build artifacts watch stale template main.js dist',
    level: 'N3',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-job-status',
    query: 'job status FEAT-033 status retriever',
    level: 'N2',
    origin: 'emulated',
    type: 'and',
    realShape: true,
  },
  {
    id: 'rs-project-slug',
    query: 'projectId slug uuid validation',
    level: 'N2',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-arch-overview',
    query: 'architecture-overview',
    level: 'N0',
    origin: 'emulated',
    type: 'identifier',
    realShape: true,
  },
  {
    id: 'rs-rag-single',
    query: 'RAG',
    level: 'N0',
    origin: 'emulated',
    type: 'exact',
    realShape: true,
  },
  {
    id: 'rs-iframe-crossspace',
    query: 'iframe',
    level: 'N0',
    origin: 'emulated',
    type: 'exact',
    realShape: true,
  },
];

// ── 2. Generated cases ──

/** Longest name token — used as a distinctive single-token anchor. */
function anchorToken(name: string): string | null {
  const tokens = anchorTokenCache.get(name);
  if (tokens) return tokens;
  const longest = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  const value = longest ? longest.toLowerCase() : null;
  anchorTokenCache.set(name, value);
  return value;
}
const anchorTokenCache = new Map<string, string | null>();

function anchorCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const doc of FIXTURE_CORPUS) {
    const token = anchorToken(doc.name);
    if (!token || token.length < MIN_ANCHOR_TOKEN_LENGTH) continue;
    cases.push(
      buildCase({
        id: `anchor-${doc.space.split('/').pop()}-${doc.name}`,
        query: token,
        level: 'N0',
        origin: 'emulated',
        type: 'exact',
        spec: { kind: 'all', tokens: [token] },
      })
    );
  }
  return cases;
}

function nameLookupCases(): EvalCase[] {
  return FIXTURE_CORPUS.map(doc =>
    buildCase({
      id: `name-${doc.space.split('/').pop()}-${doc.name}`,
      query: doc.name,
      level: 'N1',
      origin: 'emulated',
      type: 'identifier',
      spec: { kind: 'all', tokens: significantTokens(doc.name) },
    })
  );
}

const PREFIX_SEEDS = [
  'arch',
  'config',
  'token',
  'creat',
  'detach',
  'report',
  'cache',
  'embed',
  'sesion',
  'refug',
  'stat',
  'punt',
  'ogro',
  'status',
  'pala',
];

function prefixCases(): EvalCase[] {
  return PREFIX_SEEDS.map(prefix =>
    buildCase({
      id: `prefix-${prefix}`,
      query: `${prefix}*`,
      level: 'N1',
      origin: 'lab',
      type: 'prefix',
      spec: { kind: 'prefix', prefix },
    })
  );
}

const PHRASE_SEEDS = [
  'token border color',
  'large report performance',
  'sesión 16',
  'puntos de salud temporales',
  'status effects',
  'creature size',
  'deuda del profeta',
  'puerto bruma',
  'canonical creature sizes',
  'ownerDocument onDetach',
];

function phraseCases(): EvalCase[] {
  return PHRASE_SEEDS.map(phrase =>
    buildCase({
      id: `phrase-${phrase.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      query: `"${phrase}"`,
      level: 'N1',
      origin: 'lab',
      type: 'phrase',
      spec: { kind: 'phrase', phrase },
    })
  );
}

const AND_PAIRS: [string, string][] = [
  ['token', 'color'],
  ['report', 'performance'],
  ['temp', 'hp'],
  ['status', 'effects'],
  ['sesion', '16'],
  ['creature', 'size'],
  ['embedding', 'provider'],
  ['cache', 'scope'],
  ['ogro', 'statblock'],
  ['detach', 'popout'],
  ['puntaroca', 'garuda'],
  ['lobos', 'balance'],
  ['salud', 'temporal'],
  ['npc', 'fichas'],
];

function andCases(): EvalCase[] {
  return AND_PAIRS.map(([a, b]) =>
    buildCase({
      id: `and-${a}-${b}`,
      query: `${a} ${b}`,
      level: 'N2',
      origin: 'emulated',
      type: 'and',
      spec: { kind: 'all', tokens: [a, b] },
    })
  );
}

const OR_GROUPS: string[][] = [
  ['token', 'borde', 'border'],
  ['salud', 'health', 'hp'],
  ['embedding', 'semantic', 'vector'],
  ['detach', 'popout', 'desacoplar'],
  ['config', 'configuration', 'configuracion'],
  ['report', 'performance', 'pagination'],
  ['mystra', 'garak', 'sigilos'],
  ['temp', 'temporal', 'hp temporal'],
];

function orCases(): EvalCase[] {
  return OR_GROUPS.map(group =>
    buildCase({
      id: `or-${group.join('-')}`,
      query: group.join(' OR '),
      level: 'N3',
      origin: 'lab',
      type: 'or',
      spec: { kind: 'any', tokens: group },
    })
  );
}

const NOT_SEEDS: { id: string; query: string; include: string[]; exclude: string[] }[] = [
  { id: 'not-token-borde', query: 'token NOT borde', include: ['token'], exclude: ['borde'] },
  { id: 'not-report-cache', query: 'report NOT cache', include: ['report'], exclude: ['cache'] },
  { id: 'not-sesion-17', query: 'sesion NOT 17', include: ['sesion'], exclude: ['17'] },
  { id: 'not-status-cards', query: 'status NOT cards', include: ['status'], exclude: ['cards'] },
  { id: 'not-token-detach', query: 'token NOT detach', include: ['token'], exclude: ['detach'] },
  {
    id: 'not-creature-size',
    query: 'creature NOT canonical',
    include: ['creature'],
    exclude: ['canonical'],
  },
];

function notCases(): EvalCase[] {
  return NOT_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: 'N3',
      origin: 'lab',
      type: 'not',
      spec: { kind: 'not', include: seed.include, exclude: seed.exclude },
    })
  );
}

const TYPO_SEEDS: { id: string; query: string; corrected: string; level: CaseLevel }[] = [
  { id: 'typo-embeddigs', query: 'embeddigs', corrected: 'embeddings', level: 'N3' },
  { id: 'typo-confguration', query: 'confguration', corrected: 'configuration', level: 'N3' },
  { id: 'typo-statblok', query: 'statblok', corrected: 'statblock', level: 'N3' },
  { id: 'typo-puntroca', query: 'puntroca', corrected: 'puntaroca', level: 'N3' },
  { id: 'typo-cachee', query: 'cachee', corrected: 'cache', level: 'N3' },
  {
    id: 'typo-tokenbordercolour',
    query: 'tokenbordercolour',
    corrected: 'tokenbordercolor',
    level: 'N4',
  },
  {
    id: 'typo-creature-size',
    query: 'creature-size-t7-qa-verifed',
    corrected: 'creature-size-t7-qa-verified',
    level: 'N4',
  },
  { id: 'typo-refugio', query: 'refugioo', corrected: 'refugio', level: 'N3' },
];

function typoCases(): EvalCase[] {
  return TYPO_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: seed.level,
      origin: 'lab',
      type: 'typo',
      // Corrected-term intent: exactly the docs containing the corrected term
      // (exact folded substring). A morphological `all` spec would silently
      // pull in unrelated words sharing a 4-char prefix (e.g. `statblock`
      // matching `status`, `tokenbordercolor` matching any `token…`, or
      // `configuration` matching `configureSheet`).
      spec: { kind: 'literal', terms: [seed.corrected] },
    })
  );
}

const SUBSTRING_SEEDS = ['nfigura', 'formanc', 'enumbra', 'untaroca', 'abilbo', 'isplay'];

function substringCases(): EvalCase[] {
  return SUBSTRING_SEEDS.map(text =>
    buildCase({
      id: `substring-${text}`,
      query: text,
      level: 'N2',
      origin: 'lab',
      type: 'substring',
      spec: { kind: 'substring', text },
    })
  );
}

const BILINGUAL_SEEDS: {
  id: string;
  query: string;
  tokens: string[];
  expected?: string[];
  notes?: string;
}[] = [
  {
    id: 'bi-config-cache',
    query: 'configuración cache',
    tokens: ['configuracion', 'cache'],
    notes: 'intent: cache-configuration notes',
    expected: [
      ref(FIXTURE_SPACES.project, 'cache-fix-feat-023'),
      ref(FIXTURE_SPACES.project, 'spec004-feat-025'),
    ],
  },
  { id: 'bi-salud-hp', query: 'salud temporal hp', tokens: ['salud', 'temporal', 'hp'] },
  { id: 'bi-border-color', query: 'borde border color', tokens: ['borde', 'border', 'color'] },
  {
    id: 'bi-sesion-resumen',
    query: 'sesión session resumen',
    tokens: ['sesion', 'session', 'resumen'],
    notes: 'intent: the session-16 summary; "session" is Spanish "sesión" in the corpus',
    expected: [ref(FIXTURE_SPACES.ttrpg, 'sesion-16-resumen-pp')],
  },
  {
    id: 'bi-reporte-performance',
    query: 'reporte performance',
    tokens: ['reporte', 'performance'],
  },
  {
    id: 'bi-creature-criatura',
    query: 'creature criatura size',
    tokens: ['creature', 'criatura', 'size'],
  },
];

function bilingualCases(): EvalCase[] {
  return BILINGUAL_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: 'N2',
      origin: 'emulated',
      type: 'bilingual',
      spec: { kind: 'all', tokens: seed.tokens },
      expected: seed.expected,
      notes: seed.notes,
    })
  );
}

const IDENTIFIER_SEEDS = [
  'tokenBorderColor',
  '_drawBar',
  'configureSheet',
  'arcana-sheet-v2',
  'ManageCardsView',
  'TEMP_HP_ALPHA',
  't5-detach-fullbleed-verified',
  'FEAT-033',
  'forceReload',
  'ArcanaToken',
];

function identifierCases(): EvalCase[] {
  return IDENTIFIER_SEEDS.map(identifier =>
    buildCase({
      id: `ident-${identifier.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      query: identifier,
      level: 'N2',
      origin: 'emulated',
      type: 'identifier',
      spec: { kind: 'all', tokens: [identifier] },
    })
  );
}

const FILTER_SEEDS: { id: string; query: string; params: CaseParams }[] = [
  { id: 'filter-token-foundry', query: 'token', params: { space: FIXTURE_SPACES.foundry } },
  { id: 'filter-report-project', query: 'report', params: { space: FIXTURE_SPACES.project } },
  { id: 'filter-sesion-ttrpg', query: 'sesion', params: { space: FIXTURE_SPACES.ttrpg } },
  { id: 'filter-token-color-tier1', query: 'token color', params: { tier: 1 } },
  { id: 'filter-status-tier2', query: 'status effects', params: { tier: 2 } },
  { id: 'filter-puntaroca-ttrpg', query: 'puntaroca', params: { space: FIXTURE_SPACES.ttrpg } },
  { id: 'filter-statblock-tag', query: 'statblock', params: { tag: 'type:session' } },
  { id: 'filter-cache-project', query: 'cache', params: { space: FIXTURE_SPACES.project } },
  { id: 'filter-detach-tag', query: 'detach', params: { tag: 'cat:pattern' } },
];

function filterCases(): EvalCase[] {
  return FILTER_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      params: seed.params,
      level: 'N3',
      origin: 'lab',
      type: 'filter',
      spec: { kind: 'all', tokens: significantTokens(seed.query) },
    })
  );
}

const NEGATIVE_SEEDS: { id: string; query: string; level: CaseLevel; spec?: MatchSpec }[] = [
  { id: 'neg-absent-1', query: 'zzqx-nonexistent-token-9f3', level: 'N0', spec: { kind: 'empty' } },
  { id: 'neg-absent-2', query: 'photosynthesis chlorophyll', level: 'N0', spec: { kind: 'empty' } },
  { id: 'neg-absent-3', query: 'quantum entanglement', level: 'N0', spec: { kind: 'empty' } },
  { id: 'neg-absent-4', query: 'yugioh', level: 'N0', spec: { kind: 'empty' } },
  {
    id: 'neg-gap-drex-puntaroca',
    query: 'Drex Puntaroca',
    level: 'N4',
    spec: { kind: 'all', tokens: ['drex', 'puntaroca'] },
  },
  {
    id: 'neg-gap-mohabilbo-mystra',
    query: 'Mohabilbo Mystra',
    level: 'N4',
    spec: { kind: 'all', tokens: ['mohabilbo', 'mystra'] },
  },
  {
    id: 'neg-gap-cache-penumbras',
    query: 'cache Penumbras',
    level: 'N4',
    spec: { kind: 'all', tokens: ['cache', 'penumbras'] },
  },
  {
    id: 'neg-gap-token-mystra',
    query: 'configureSheet Mystra',
    level: 'N4',
    spec: { kind: 'all', tokens: ['configuresheet', 'mystra'] },
  },
  {
    id: 'neg-gap-lobos-report',
    query: 'lobos report',
    level: 'N3',
    spec: { kind: 'all', tokens: ['lobos', 'report'] },
  },
  {
    id: 'neg-semantic-gap',
    query: 'cómo viajan los héroes entre ciudades',
    level: 'N4',
    spec: { kind: 'empty' },
  },
];

function negativeCases(): EvalCase[] {
  return NEGATIVE_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: seed.level,
      origin: 'lab',
      type: 'negative',
      spec: seed.spec ?? { kind: 'empty' },
    })
  );
}

// ── 3. Curated hard/extreme (N4) cases ──

function extremeCases(): EvalCase[] {
  return [
    buildCase({
      id: 'n4-long-mixed-or',
      query: 'tokenBorderColor OR "color del borde" OR animateBars temp HP overlay alpha',
      level: 'N4',
      origin: 'lab',
      type: 'or',
      spec: {
        kind: 'any',
        tokens: ['tokenBorderColor', 'color del borde', 'animateBars temp HP overlay alpha'],
      },
    }),
    buildCase({
      id: 'n4-long-accented-and',
      query: 'Sesión 16 refugio paladines vigía Garuda progreso transcripción PP',
      level: 'N4',
      origin: 'lab',
      type: 'and',
      notes: 'intent: spans the session-16 prep + summary memories',
      expected: [
        ref(FIXTURE_SPACES.ttrpg, 'sesion-16-prep-refugio-paladines-vigia'),
        ref(FIXTURE_SPACES.ttrpg, 'sesion-16-resumen-pp'),
      ],
    }),
    buildCase({
      id: 'n4-not-with-filter',
      query: 'token NOT detach',
      params: { space: FIXTURE_SPACES.foundry },
      level: 'N4',
      origin: 'lab',
      type: 'not',
      spec: { kind: 'not', include: ['token'], exclude: ['detach'] },
    }),
    buildCase({
      id: 'n4-or-five',
      query: 'mystra OR garak OR sigilos OR penumbras OR goro',
      level: 'N4',
      origin: 'lab',
      type: 'or',
      spec: { kind: 'any', tokens: ['mystra', 'garak', 'sigilos', 'penumbras', 'goro'] },
    }),
    buildCase({
      id: 'n4-or-identifiers',
      query: '_drawBar OR uiScale OR animateBars OR forceReload',
      level: 'N4',
      origin: 'lab',
      type: 'or',
      spec: { kind: 'any', tokens: ['_drawBar', 'uiScale', 'animateBars', 'forceReload'] },
    }),
    buildCase({
      id: 'n4-phrase-accented',
      query: '"puntos de salud temporales"',
      level: 'N4',
      origin: 'lab',
      type: 'phrase',
      spec: { kind: 'phrase', phrase: 'puntos de salud temporales' },
    }),
    buildCase({
      id: 'n4-substring-identifier',
      query: 'nA-sheet-v2',
      level: 'N4',
      origin: 'lab',
      type: 'substring',
      spec: { kind: 'substring', text: 'nA-sheet-v2' },
    }),
  ];
}

let cachedCases: EvalCase[] | null = null;

/** All fixture cases, built once and cached (fully deterministic). */
export function buildFixtureCases(): EvalCase[] {
  if (cachedCases) return cachedCases;
  cachedCases = [
    ...REAL_SHAPE_SEEDS.map(buildCase),
    ...anchorCases(),
    ...nameLookupCases(),
    ...prefixCases(),
    ...phraseCases(),
    ...andCases(),
    ...orCases(),
    ...notCases(),
    ...typoCases(),
    ...substringCases(),
    ...bilingualCases(),
    ...identifierCases(),
    ...filterCases(),
    ...negativeCases(),
    ...extremeCases(),
  ];
  assertUniqueIds(cachedCases);
  assertLabelInvariant(cachedCases);
  return cachedCases;
}

function assertUniqueIds(cases: EvalCase[]): void {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`Duplicate eval case id: ${testCase.id}`);
    seen.add(testCase.id);
  }
}

/**
 * Every non-negative case must have at least one expected label (otherwise it
 * is a vacuous test), and every negative case must expect nothing.
 */
function assertLabelInvariant(cases: EvalCase[]): void {
  const violations = cases.filter(testCase =>
    testCase.type === 'negative' ? testCase.expected.length !== 0 : testCase.expected.length === 0
  );
  if (violations.length > 0) {
    const ids = violations.map(testCase => testCase.id).join(', ');
    throw new Error(`Label invariant violation (${violations.length}): ${ids}`);
  }
}
