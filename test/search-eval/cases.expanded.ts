// ── Expanded (v2) evaluation cases for the search suite ──
//
// Deterministic cases over `V2_CORPUS`, covering every axis the optimization
// work must defend: first-3-char typos, adjacent transpositions, insertions and
// deletions, very short and very long words, query-length buckets, accents and
// ñ/n pairs, ES/EN pairs, substrings at start/mid/end, identifiers, long
// memories, frequent tokens, hard negatives, near-duplicate distractors,
// irrelevant queries, and adversarial anti-bias cases with neutral controls.
//
// Expectations are derived from the corpus with the existing `deriveExpected` +
// `MatchSpec` machinery (never from engine output). A handful of cases whose
// intent is a *semantic* distinction that folding cannot express (e.g. `año` vs
// `ano`) carry explicit curated labels with an explanatory note.
//
// Build is cached and fully deterministic: no randomness, no timestamps, sorted
// iteration only.

import { EXPANDED_CORPUS, EXPANDED_SPACES, V2_CORPUS } from './corpus.expanded';
import { deriveExpected, tokenizeWords, type MatchSpec } from './ground-truth';
import { refOf } from './refs';
import type { CaseLevel, CaseOrigin, CaseParams, CaseType, EvalCase } from './types';

const OR_SPLIT = /\s+OR\s+/i;
const MIN_ANCHOR_TOKEN_LENGTH = 5;
const STOPWORDS = new Set([
  'el',
  'la',
  'lo',
  'los',
  'las',
  'un',
  'una',
  'de',
  'del',
  'en',
  'y',
  'o',
  'al',
  'se',
  'su',
  'es',
  'que',
  'con',
  'por',
  'para',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'cada',
  'tras',
  'por',
]);

function ref(space: string, name: string): string {
  return refOf(space, name);
}

/** Significant query tokens (drops quotes, wildcards and boolean operators). */
function significantTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map(part => part.replace(/[*"]/g, '').trim())
    .filter(part => part.length > 0 && !/^(OR|AND|NOT)$/i.test(part));
}

/** Build an "any of these operands" spec from an `A OR B` query. */
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
  spec?: MatchSpec;
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
    expected: seed.expected ?? deriveExpected(V2_CORPUS, spec, params),
    level: seed.level,
    origin: seed.origin,
    type: seed.type,
    realShape: seed.realShape,
    notes: seed.notes,
  };
}

/** Longest name token, lowercased — a distinctive single-token anchor. */
function anchorToken(name: string): string | null {
  const longest = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  return longest ? longest.toLowerCase() : null;
}

/** Contiguous start/mid/end slices of a token (each at least 3 chars). */
function slices(token: string): { start: string; mid: string; end: string } {
  const middle = Math.floor(token.length / 2);
  return {
    start: token.slice(0, 4),
    mid: token.slice(Math.max(0, middle - 2), middle + 2),
    end: token.slice(-5),
  };
}

// ── Derived generators over the expanded corpus ──

function anchorCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const doc of EXPANDED_CORPUS) {
    const token = anchorToken(doc.name);
    if (!token || token.length < MIN_ANCHOR_TOKEN_LENGTH) continue;
    cases.push(
      buildCase({
        id: `v2-anchor-${doc.name}`,
        query: token,
        level: 'N0',
        origin: 'lab',
        type: 'exact',
        spec: { kind: 'all', tokens: [token] },
      })
    );
  }
  return cases;
}

function nameLookupCases(): EvalCase[] {
  return EXPANDED_CORPUS.map(doc =>
    buildCase({
      id: `v2-name-${doc.name}`,
      query: doc.name,
      level: 'N1',
      origin: 'lab',
      type: 'identifier',
      spec: { kind: 'all', tokens: significantTokens(doc.name) },
    })
  );
}

const SUBSTRING_TOKENS = [
  'configuracion',
  'puntuacion',
  'internacionalizacion',
  'contrarrevolucionario',
  'electroencefalograma',
  'zentharion',
  'obsidiana',
  'vespertino',
  'handleSearchResults',
  'parseQueryAstNotation',
  'search_fusion_weights',
  'ranking_metrics_v2',
  'canaveral',
  'corazon',
];

function substringCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const token of SUBSTRING_TOKENS) {
    const { start, mid, end } = slices(token);
    for (const [label, text] of [
      ['start', start],
      ['mid', mid],
      ['end', end],
    ] as const) {
      if (text.length < 3) continue;
      cases.push(
        buildCase({
          id: `v2-substring-${label}-${token}`,
          query: text,
          level: label === 'mid' ? 'N3' : 'N2',
          origin: 'lab',
          type: 'substring',
          spec: { kind: 'substring', text },
        })
      );
    }
  }
  return cases;
}

const PREFIX_SEEDS = [
  'config',
  'punt',
  'accio',
  'regis',
  'inter',
  'contra',
  'electro',
  'cache',
  'spec',
  'search',
  'handl',
  'rank',
];

function prefixCases(): EvalCase[] {
  return PREFIX_SEEDS.map(prefix =>
    buildCase({
      id: `v2-prefix-${prefix}`,
      query: `${prefix}*`,
      level: 'N1',
      origin: 'lab',
      type: 'prefix',
      spec: { kind: 'prefix', prefix },
    })
  );
}

const PHRASE_SEEDS = [
  'configuración inicial',
  'puntuación final',
  'acción encadenada',
  'caña de pescar',
  'año fiscal',
  'cabello cano',
  'registro interno',
  'search_fusion_weights',
];

function phraseCases(): EvalCase[] {
  return PHRASE_SEEDS.map(phrase =>
    buildCase({
      id: `v2-phrase-${phrase.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      query: `"${phrase}"`,
      level: 'N2',
      origin: 'lab',
      type: 'phrase',
      spec: { kind: 'phrase', phrase },
    })
  );
}

const AND_PAIRS: [string, string][] = [
  ['configuracion', 'puntuacion'],
  ['accion', 'reaccion'],
  ['registro', 'nodo'],
  ['cache', 'alpha'],
  ['cache', 'beta'],
  ['spec005', 'feat-026'],
  ['hp', 'temporal'],
  ['electroencefalograma', 'actividad'],
  ['search_fusion_weights', 'canal'],
  ['ranking_metrics_v2', 'ndcg'],
  ['handleSearchResults', 'resultados'],
  ['glosario', 'memoria'],
  ['ano', 'fiscal'],
  ['caña', 'pescar'],
];

function andCases(): EvalCase[] {
  return AND_PAIRS.map(([a, b]) =>
    buildCase({
      id: `v2-and-${a}-${b}`,
      query: `${a} ${b}`,
      level: 'N2',
      origin: 'emulated',
      type: 'and',
      spec: { kind: 'all', tokens: [a, b] },
    })
  );
}

const OR_GROUPS: string[][] = [
  ['configuracion', 'configuration', 'config'],
  ['puntuacion', 'score', 'puntos'],
  ['accion', 'reaccion', 'evento'],
  ['registro', 'incidencia', 'alerta'],
  ['alpha', 'beta', 'gamma'],
  ['zentharion', 'obsidiana', 'vespertino'],
];

function orCases(): EvalCase[] {
  return OR_GROUPS.map(group =>
    buildCase({
      id: `v2-or-${group.join('-')}`,
      query: group.join(' OR '),
      level: 'N3',
      origin: 'lab',
      type: 'or',
      spec: { kind: 'any', tokens: group },
    })
  );
}

const NOT_SEEDS: { id: string; query: string; include: string[]; exclude: string[] }[] = [
  {
    id: 'v2-not-registro-temp',
    query: 'registro NOT temperatura',
    include: ['registro'],
    exclude: ['temperatura'],
  },
  {
    id: 'v2-not-configuracion-red',
    query: 'configuracion NOT red',
    include: ['configuracion'],
    exclude: ['red'],
  },
  { id: 'v2-not-cache-beta', query: 'cache NOT beta', include: ['cache'], exclude: ['beta'] },
  {
    id: 'v2-not-search-snake',
    query: 'search NOT fusion',
    include: ['search'],
    exclude: ['fusion'],
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

// ── Typos: general, first-3, transposition, insertion, deletion ──

const TYPO_SEEDS: { id: string; query: string; corrected: string; level: CaseLevel }[] = [
  { id: 'v2-typo-configuracion', query: 'configuracon', corrected: 'configuracion', level: 'N3' },
  { id: 'v2-typo-puntuacion', query: 'puntuacionn', corrected: 'puntuacion', level: 'N3' },
  {
    id: 'v2-typo-electroncefalograma',
    query: 'electrocefalograma',
    corrected: 'electroencefalograma',
    level: 'N4',
  },
  {
    id: 'v2-typo-contrarrevolucionaro',
    query: 'contrarrevolucionaro',
    corrected: 'contrarrevolucionario',
    level: 'N4',
  },
  { id: 'v2-typo-canaberal', query: 'canaberal', corrected: 'canaveral', level: 'N3' },
  { id: 'v2-typo-registro', query: 'regitro', corrected: 'registro', level: 'N3' },
];

/** First-3-char error: the exact prefix that the old fuzzy path depended on. */
const FIRST3_SEEDS: { id: string; query: string; corrected: string }[] = [
  { id: 'v2-first3-configuracion', query: 'xonfiguracion', corrected: 'configuracion' },
  { id: 'v2-first3-puntuacion', query: 'quntuacion', corrected: 'puntuacion' },
  { id: 'v2-first3-accion', query: 'eccion', corrected: 'accion' },
  { id: 'v2-first3-registro', query: 'qegistro', corrected: 'registro' },
  { id: 'v2-first3-canaveral', query: 'xanaveral', corrected: 'canaveral' },
  { id: 'v2-first3-zentharion', query: 'xentharion', corrected: 'zentharion' },
  { id: 'v2-first3-obsidiana', query: 'obsidixna', corrected: 'obsidiana' },
  { id: 'v2-first3-vespertino', query: 'xespertino', corrected: 'vespertino' },
  {
    id: 'v2-first3-internacionalizacion',
    query: 'xnternacionalizacion',
    corrected: 'internacionalizacion',
  },
  {
    id: 'v2-first3-electroencefalograma',
    query: 'xlectroencefalograma',
    corrected: 'electroencefalograma',
  },
  {
    id: 'v2-first3-contrarrevolucionario',
    query: 'xontrarrevolucionario',
    corrected: 'contrarrevolucionario',
  },
  { id: 'v2-first3-corazon', query: 'xorazon', corrected: 'corazon' },
];

const TRANSPOSITION_SEEDS: { id: string; query: string; corrected: string }[] = [
  { id: 'v2-trans-configuracion', query: 'configuraiton', corrected: 'configuracion' },
  { id: 'v2-trans-puntuacion', query: 'puntuacoin', corrected: 'puntuacion' },
  { id: 'v2-trans-registro', query: 'regsitro', corrected: 'registro' },
  { id: 'v2-trans-canaveral', query: 'canaverla', corrected: 'canaveral' },
  { id: 'v2-trans-zentharion', query: 'zentharoin', corrected: 'zentharion' },
  { id: 'v2-trans-obsidiana', query: 'obsidaina', corrected: 'obsidiana' },
  { id: 'v2-trans-vespertino', query: 'vespertnio', corrected: 'vespertino' },
  {
    id: 'v2-trans-electroencefalograma',
    query: 'electroencefalgorama',
    corrected: 'electroencefalograma',
  },
  {
    id: 'v2-trans-contrarrevolucionario',
    query: 'contrarrevolucionairo',
    corrected: 'contrarrevolucionario',
  },
  { id: 'v2-trans-corazon', query: 'corazno', corrected: 'corazon' },
  {
    id: 'v2-trans-internacionalizacion',
    query: 'internacionalizaicon',
    corrected: 'internacionalizacion',
  },
  { id: 'v2-trans-accion', query: 'accino', corrected: 'accion' },
];

const INSERTION_SEEDS = [
  'configuracion',
  'puntuacion',
  'registro',
  'zentharion',
  'obsidiana',
  'vespertino',
].map((term, index) => {
  const position = Math.max(3, Math.floor(term.length / 2));
  const query = `${term.slice(0, position)}${'zx'[index % 2]}${term.slice(position)}`;
  return { id: `v2-insertion-${term}`, query, corrected: term };
});

const DELETION_SEEDS = [
  'configuracion',
  'puntuacion',
  'registro',
  'zentharion',
  'obsidiana',
  'vespertino',
].map(term => {
  const position = Math.max(3, Math.floor(term.length / 2));
  const query = term.slice(0, position) + term.slice(position + 1);
  return { id: `v2-deletion-${term}`, query, corrected: term };
});

function correctedLiteralCase(
  id: string,
  query: string,
  corrected: string,
  type: CaseType,
  level: CaseLevel
): EvalCase {
  // Corrected-term intent: exactly the docs containing the corrected term
  // (exact folded substring). `literal` avoids morphology over-inclusion.
  return buildCase({
    id,
    query,
    level,
    origin: 'lab',
    type,
    spec: { kind: 'literal', terms: [corrected] },
  });
}

function typoCases(): EvalCase[] {
  return TYPO_SEEDS.map(seed =>
    correctedLiteralCase(seed.id, seed.query, seed.corrected, 'typo', seed.level)
  );
}

function first3Cases(): EvalCase[] {
  return FIRST3_SEEDS.map(seed =>
    correctedLiteralCase(seed.id, seed.query, seed.corrected, 'first3typo', 'N4')
  );
}

function transpositionCases(): EvalCase[] {
  return TRANSPOSITION_SEEDS.map(seed =>
    correctedLiteralCase(seed.id, seed.query, seed.corrected, 'transposition', 'N4')
  );
}

function insertionCases(): EvalCase[] {
  return INSERTION_SEEDS.map(seed =>
    correctedLiteralCase(seed.id, seed.query, seed.corrected, 'insertion', 'N4')
  );
}

function deletionCases(): EvalCase[] {
  return DELETION_SEEDS.map(seed =>
    correctedLiteralCase(seed.id, seed.query, seed.corrected, 'deletion', 'N4')
  );
}

// ── Short tokens (<3 chars) and long rare words (>16 chars) ──

const SHORT_TOKEN_SEEDS = ['hp', 'pp', 'ui', 'id'];
const SHORT_TOKEN_LEVELS: Record<string, CaseLevel> = { hp: 'N4', pp: 'N4', ui: 'N4', id: 'N4' };

function shortTokenCases(): EvalCase[] {
  return SHORT_TOKEN_SEEDS.map(token =>
    buildCase({
      id: `v2-shorttoken-${token}`,
      query: token,
      level: SHORT_TOKEN_LEVELS[token] ?? 'N4',
      origin: 'lab',
      type: 'shorttoken',
      spec: { kind: 'all', tokens: [token] },
    })
  );
}

const LONG_WORD_SEEDS = [
  'internacionalizacion',
  'contrarrevolucionario',
  'electroencefalograma',
  'desconfiguracion',
  'search_fusion_weights',
  'ranking_metrics_v2',
  'parseQueryAstNotation',
];

function longWordCases(): EvalCase[] {
  return LONG_WORD_SEEDS.map(term =>
    buildCase({
      id: `v2-longword-${term.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      query: term,
      level: 'N2',
      origin: 'lab',
      type: 'identifier',
      spec: { kind: 'literal', terms: [term] },
    })
  );
}

// ── Query-length buckets (1/2/3/5/8/12 tokens) ──

const QUERY_LENGTH_BUCKETS: { bucket: 1 | 2 | 3 | 5 | 8 | 12; docs: string[] }[] = [
  { bucket: 1, docs: ['guia-configuracion', 'informe-largo-zentharion'] },
  { bucket: 2, docs: ['configuracion-red', 'puntuacion-examen'] },
  { bucket: 3, docs: ['glossary-es-en', 'handleSearchResults-impl'] },
  { bucket: 5, docs: ['guia-configuracion', 'catalogo-prolijo-vespertino'] },
  { bucket: 8, docs: ['informe-largo-zentharion', 'bitacora-larga-obsidiana'] },
  { bucket: 12, docs: ['manual-extenso-plutonio'] },
];

function contentTokens(docName: string): string[] {
  const doc = V2_CORPUS.find(candidate => candidate.name === docName);
  if (!doc) throw new Error(`query-length: unknown doc ${docName}`);
  return tokenizeWords(`${doc.name} ${doc.content}`).filter(
    token => token.length >= 3 && !STOPWORDS.has(token)
  );
}

function queryLengthCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const { bucket, docs } of QUERY_LENGTH_BUCKETS) {
    for (const docName of docs) {
      const tokens = [...new Set(contentTokens(docName))].slice(0, bucket);
      if (tokens.length === 0) continue;
      const query = tokens.join(' ');
      cases.push(
        buildCase({
          id: `v2-querylength-${bucket}-${docName}`,
          query,
          level: bucket >= 8 ? 'N4' : bucket >= 5 ? 'N3' : 'N2',
          origin: 'lab',
          type: 'querylength',
          spec: { kind: 'all', tokens },
        })
      );
    }
  }
  return cases;
}

// ── Long memories: recover the rare token buried mid-document ──

const LONG_MEMORY_SEEDS: { id: string; token: string }[] = [
  { id: 'v2-longmemory-zentharion', token: 'zentharion' },
  { id: 'v2-longmemory-plutonio', token: 'plutonio-enriquecido-x9' },
  { id: 'v2-longmemory-obsidiana', token: 'obsidiana-negra' },
  { id: 'v2-longmemory-vespertino', token: 'vespertino' },
];

function longMemoryCases(): EvalCase[] {
  return LONG_MEMORY_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.token,
      level: 'N3',
      origin: 'lab',
      type: 'longmemory',
      spec: { kind: 'literal', terms: [seed.token] },
    })
  );
}

// ── Frequent tokens ──

const FREQUENT_TOKENS = ['registro', 'configuracion', 'accion', 'cache'];

function frequentCases(): EvalCase[] {
  return FREQUENT_TOKENS.map(token =>
    buildCase({
      id: `v2-frequent-${token}`,
      query: token,
      level: 'N1',
      origin: 'lab',
      type: 'frequent',
      spec: { kind: 'all', tokens: [token] },
    })
  );
}

// ── Bilingual ES/EN pairs ──

const BILINGUAL_PAIRS: { id: string; query: string; tokens: string[] }[] = [
  { id: 'v2-bi-memory', query: 'memory memoria', tokens: ['memory', 'memoria'] },
  { id: 'v2-bi-search', query: 'search busqueda', tokens: ['search', 'busqueda'] },
  { id: 'v2-bi-space', query: 'space espacio', tokens: ['space', 'espacio'] },
  { id: 'v2-bi-link', query: 'link enlace', tokens: ['link', 'enlace'] },
  { id: 'v2-bi-tag', query: 'tag etiqueta', tokens: ['tag', 'etiqueta'] },
  { id: 'v2-bi-border-color', query: 'border borde color', tokens: ['border', 'borde', 'color'] },
  {
    id: 'v2-bi-config',
    query: 'configuration configuracion',
    tokens: ['configuration', 'configuracion'],
  },
  { id: 'v2-bi-cache', query: 'cache scope alpha', tokens: ['cache', 'scope', 'alpha'] },
];

function bilingualCases(): EvalCase[] {
  return BILINGUAL_PAIRS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: 'N2',
      origin: 'emulated',
      type: 'bilingual',
      spec: { kind: 'all', tokens: seed.tokens },
    })
  );
}

// ── Identifiers (camelCase / kebab-case / snake_case) ──

const IDENTIFIER_SEEDS = [
  'handleSearchResults',
  'parseQueryAstNotation',
  'search-eval-v2-runner',
  'multi-token-query-builder',
  'search_fusion_weights',
  'ranking_metrics_v2',
  'plutonio-enriquecido-x9',
  'obsidiana-negra',
];

function identifierCases(): EvalCase[] {
  return IDENTIFIER_SEEDS.map(identifier =>
    buildCase({
      id: `v2-ident-${identifier.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      query: identifier,
      level: 'N2',
      origin: 'lab',
      type: 'identifier',
      spec: { kind: 'all', tokens: [identifier] },
    })
  );
}

// ── Near-duplicate distractors ──

const NEAR_DUPLICATE_SEEDS: { id: string; query: string; tokens: string[] }[] = [
  { id: 'v2-neardup-cache-alpha', query: 'cache scope alpha', tokens: ['cache', 'scope', 'alpha'] },
  { id: 'v2-neardup-cache-beta', query: 'cache scope beta', tokens: ['cache', 'scope', 'beta'] },
  { id: 'v2-neardup-spec005', query: 'spec005 feat-026', tokens: ['spec005', 'feat-026'] },
  { id: 'v2-neardup-registro-norte', query: 'registro norte', tokens: ['registro', 'norte'] },
  { id: 'v2-neardup-registro-sur', query: 'registro sur', tokens: ['registro', 'sur'] },
  {
    id: 'v2-neardup-configuracion-red',
    query: 'configuracion proxy',
    tokens: ['configuracion', 'proxy'],
  },
  { id: 'v2-neardup-puntuacion-final', query: 'puntuacion final', tokens: ['puntuacion', 'final'] },
  {
    id: 'v2-neardup-puntuacion-seccion',
    query: 'puntuacion seccion',
    tokens: ['puntuacion', 'seccion'],
  },
];

function nearDuplicateCases(): EvalCase[] {
  return NEAR_DUPLICATE_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: 'N3',
      origin: 'lab',
      type: 'nearDuplicate',
      spec: { kind: 'all', tokens: seed.tokens },
    })
  );
}

// ── Hard negatives + irrelevant queries ──

const NEGATIVE_SEEDS: { id: string; query: string; level: CaseLevel; spec: MatchSpec }[] = [
  { id: 'v2-neg-absent-1', query: 'zzqx-nonexistent-9f3', level: 'N0', spec: { kind: 'empty' } },
  { id: 'v2-neg-absent-2', query: 'fotosintesis clorofila', level: 'N0', spec: { kind: 'empty' } },
  {
    id: 'v2-neg-absent-3',
    query: 'entrelazamiento cuantico',
    level: 'N0',
    spec: { kind: 'empty' },
  },
  {
    id: 'v2-neg-gap-crossspace',
    query: 'zentharion vespertino',
    level: 'N4',
    spec: { kind: 'all', tokens: ['zentharion', 'vespertino'] },
  },
  {
    id: 'v2-neg-gap-crossspace-2',
    query: 'obsidiana alpha',
    level: 'N4',
    spec: { kind: 'all', tokens: ['obsidiana', 'alpha'] },
  },
  {
    id: 'v2-neg-gap-config-zentharion',
    query: 'configuracion zentharion',
    level: 'N4',
    spec: { kind: 'all', tokens: ['configuracion', 'zentharion'] },
  },
  {
    id: 'v2-neg-gap-plutonio-cache',
    query: 'plutonio-enriquecido-x9 cache',
    level: 'N4',
    spec: { kind: 'all', tokens: ['plutonio-enriquecido-x9', 'cache'] },
  },
  {
    id: 'v2-neg-neardup-opposites',
    query: 'alpha beta',
    level: 'N4',
    spec: { kind: 'all', tokens: ['alpha', 'beta'] },
  },
  {
    id: 'v2-neg-neardup-spec',
    query: 'spec004 feat-026',
    level: 'N4',
    spec: { kind: 'empty' },
  },
  {
    id: 'v2-neg-semantic-gap',
    query: 'cómo migran las aves entre continentes',
    level: 'N4',
    spec: { kind: 'empty' },
  },
  { id: 'v2-neg-absent-4', query: 'yugioh holograma', level: 'N0', spec: { kind: 'empty' } },
];

function negativeCases(): EvalCase[] {
  return NEGATIVE_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: seed.level,
      origin: 'lab',
      type: 'negative',
      spec: seed.spec,
    })
  );
}

// ── Adversarial anti-bias + neutral controls ──
//
// Curated labels: the intent IS the label. These cases deliberately expose
// risks of the planned optimizations (diacritic folding collapsing `año`/`ano`
// and `caña`/`cana`) and cases where the OLD engine already succeeds (first-3
// prefix intact, exact identifiers) so the new engine cannot regress them.

function antiBiasCases(): EvalCase[] {
  const project = EXPANDED_SPACES.project;
  const i18n = EXPANDED_SPACES.i18n;
  return [
    buildCase({
      id: 'v2-antibias-ano-semantic',
      query: 'año',
      level: 'N4',
      origin: 'lab',
      type: 'anti_bias',
      notes:
        'RISK: folded trigram (R1) collapses añ→an, so `año` may also return the `cana` doc. Real relevance is the año doc only.',
      expected: [ref(project, 'ano-fiscal-2026')],
    }),
    buildCase({
      id: 'v2-antibias-cana-semantic',
      query: 'caña',
      level: 'N4',
      origin: 'lab',
      type: 'anti_bias',
      notes:
        'RISK: folded trigram collapses ñ→n; `caña` may also return the `cana`/`canaveral` docs. Real relevance is the cañaveral doc only.',
      expected: [ref(i18n, 'canaveral-rio')],
    }),
    buildCase({
      id: 'v2-neg-antibias-ano-cana',
      query: 'año caña',
      level: 'N4',
      origin: 'lab',
      type: 'negative',
      notes:
        'RISK: after folding, `año`+`caña` collapse toward `ano`/`cana`; no corpus doc is truly about both, so a correct engine returns nothing.',
      spec: { kind: 'empty' },
    }),
    buildCase({
      id: 'v2-antibias-old-prefix-intact',
      query: 'confguration',
      level: 'N3',
      origin: 'lab',
      type: 'anti_bias',
      notes:
        'OLD-ENGINE-FAVORING: first 3 chars intact, the old prefix path already finds `configuration`.',
      spec: { kind: 'literal', terms: ['configuration'] },
    }),
    buildCase({
      id: 'v2-antibias-old-identifier-exact',
      query: 'handleSearchResults',
      level: 'N1',
      origin: 'lab',
      type: 'anti_bias',
      notes: 'OLD-ENGINE-FAVORING: exact identifier with a distinctive camelCase boundary.',
      spec: { kind: 'literal', terms: ['handleSearchResults'] },
    }),
    buildCase({
      id: 'v2-antibias-old-exact-accent',
      query: 'configuración',
      level: 'N2',
      origin: 'lab',
      type: 'anti_bias',
      notes: 'OLD-ENGINE-FAVORING: the accented form is already present verbatim in the corpus.',
      spec: { kind: 'literal', terms: ['configuración'] },
    }),
  ];
}

function neutralCases(): EvalCase[] {
  const project = EXPANDED_SPACES.project;
  const i18n = EXPANDED_SPACES.i18n;
  return [
    buildCase({
      id: 'v2-neutral-exact-name',
      query: 'guia-configuracion',
      level: 'N0',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'all', tokens: ['guia', 'configuracion'] },
    }),
    buildCase({
      id: 'v2-neutral-exact-name-2',
      query: 'glossary-es-en',
      level: 'N0',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'all', tokens: ['glossary', 'es', 'en'] },
    }),
    buildCase({
      id: 'v2-neutral-single-token-substring',
      query: 'zentharion',
      level: 'N1',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'literal', terms: ['zentharion'] },
    }),
    buildCase({
      id: 'v2-neutral-plutonio-token',
      query: 'plutonio-enriquecido-x9',
      level: 'N1',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'literal', terms: ['plutonio-enriquecido-x9'] },
    }),
    buildCase({
      id: 'v2-neutral-filter-space',
      query: 'registro',
      params: { space: project },
      level: 'N2',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'all', tokens: ['registro'] },
    }),
    buildCase({
      id: 'v2-neutral-filter-tier',
      query: 'configuracion',
      params: { tier: 2 },
      level: 'N2',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'all', tokens: ['configuracion'] },
    }),
    buildCase({
      id: 'v2-neutral-i18n-space',
      query: 'puntuacion',
      params: { space: i18n },
      level: 'N2',
      origin: 'emulated',
      type: 'neutral',
      spec: { kind: 'all', tokens: ['puntuacion'] },
    }),
  ];
}

// ── Accents / diacritics: fold ↔ unfold, case, and ñ/n pairs ──
//
// Expectations use the folded `substring` spec so they are derived from the
// corpus (which contains the accented forms). `ñ`/`n` semantic distinctions are
// covered separately by the curated `anti_bias` cases below.

const DIACRITIC_SEEDS: { id: string; query: string; folded: string; note?: string }[] = [
  { id: 'v2-diac-configuracion-folded', query: 'configuracion', folded: 'configuracion' },
  { id: 'v2-diac-configuracion-unfolded', query: 'configuración', folded: 'configuracion' },
  { id: 'v2-diac-configuracion-upper', query: 'CONFIGURACIÓN', folded: 'configuracion' },
  { id: 'v2-diac-puntuacion-folded', query: 'puntuacion', folded: 'puntuacion' },
  { id: 'v2-diac-puntuacion-unfolded', query: 'puntuación', folded: 'puntuacion' },
  { id: 'v2-diac-puntuacion-upper', query: 'PUNTUACIÓN', folded: 'puntuacion' },
  { id: 'v2-diac-accion-folded', query: 'accion', folded: 'accion' },
  { id: 'v2-diac-accion-unfolded', query: 'acción', folded: 'accion' },
  { id: 'v2-diac-corazon-folded', query: 'corazon', folded: 'corazon' },
  { id: 'v2-diac-corazon-unfolded', query: 'corazón', folded: 'corazon' },
  { id: 'v2-diac-cancion-upper', query: 'CANCIÓN', folded: 'cancion' },
  {
    id: 'v2-diac-ano-folded',
    query: 'año',
    folded: 'ano',
    note: 'RISK: folding collapses añ→an; the labelled set is every doc containing the folded form.',
  },
  {
    id: 'v2-diac-cana-folded',
    query: 'caña',
    folded: 'cana',
    note: 'RISK: folding collapses ñ→n; the labelled set is every doc containing the folded form.',
  },
  { id: 'v2-diac-glosario', query: 'bilingüe', folded: 'bilingue' },
];

function diacriticCases(): EvalCase[] {
  return DIACRITIC_SEEDS.map(seed =>
    buildCase({
      id: seed.id,
      query: seed.query,
      level: 'N2',
      origin: 'lab',
      type: 'diacritics',
      spec: { kind: 'substring', text: seed.folded },
      notes: seed.note,
    })
  );
}

let cached: EvalCase[] | null = null;

/** All v2 cases, built once and cached (fully deterministic). */
export function buildV2Cases(): EvalCase[] {
  if (cached) return cached;
  cached = [
    ...anchorCases(),
    ...nameLookupCases(),
    ...substringCases(),
    ...diacriticCases(),
    ...prefixCases(),
    ...phraseCases(),
    ...andCases(),
    ...orCases(),
    ...notCases(),
    ...typoCases(),
    ...first3Cases(),
    ...transpositionCases(),
    ...insertionCases(),
    ...deletionCases(),
    ...shortTokenCases(),
    ...longWordCases(),
    ...queryLengthCases(),
    ...longMemoryCases(),
    ...frequentCases(),
    ...bilingualCases(),
    ...identifierCases(),
    ...nearDuplicateCases(),
    ...negativeCases(),
    ...antiBiasCases(),
    ...neutralCases(),
  ];
  assertUniqueIds(cached);
  assertLabelInvariant(cached);
  return cached;
}

function assertUniqueIds(cases: EvalCase[]): void {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`Duplicate v2 eval case id: ${testCase.id}`);
    seen.add(testCase.id);
  }
}

function assertLabelInvariant(cases: EvalCase[]): void {
  const violations = cases.filter(testCase =>
    testCase.type === 'negative' ? testCase.expected.length !== 0 : testCase.expected.length === 0
  );
  if (violations.length > 0) {
    const ids = violations.map(testCase => testCase.id).join(', ');
    throw new Error(`v2 label invariant violation (${violations.length}): ${ids}`);
  }
}
