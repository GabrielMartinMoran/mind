// ── Ground truth derivation for the eval suite ──
//
// A case declares an explicit `MatchSpec` describing what a correct engine
// should consider relevant. `deriveExpected` scans the corpus with that spec
// (case/diacritic-insensitive substring matching) and returns the matching
// memory refs, sorted for determinism. This keeps every case's labels explicit
// and reproducible from the committed corpus without hand-maintaining large
// label lists.

import { refOf, sortRefs } from './refs';
import type { CaseParams } from './types';

export interface CorpusDoc {
  space: string;
  name: string;
  content: string;
  tier: 1 | 2 | 3;
  tags: string[];
}

export type MatchSpec =
  | { kind: 'all'; tokens: string[] }
  | { kind: 'any'; tokens: string[] }
  | { kind: 'phrase'; phrase: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'substring'; text: string }
  | { kind: 'literal'; terms: string[] }
  | { kind: 'not'; include: string[]; exclude: string[] }
  | { kind: 'empty' };

const DIACRITICS = /[\u0300-\u036f]/g;

/**
 * Minimum shared prefix length for conservative morphology tolerance. Two
 * tokens (each at least this long) are treated as a match when they share a
 * prefix this long — enough to bridge inflections like `ogros`/`ogro` or
 * `animacion`/`animation`, without collapsing unrelated words.
 */
export const MORPH_MIN_PREFIX = 4;

/** Lowercase and strip diacritics so `acción` matches `accion`. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/** Split text into normalized alphanumeric word tokens (camelCase split too). */
export function tokenizeWords(text: string): string[] {
  return normalizeText(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Split a raw query token into normalized sub-tokens, breaking on hyphens,
 * underscores and camelCase boundaries (e.g. `la-deuda-del-profeta` →
 * `la,deuda,del,profeta`; `tokenBorderColor` → `token,border,color`).
 */
export function splitSubTokens(raw: string): string[] {
  return tokenizeWords(raw);
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}

/** Whether a single (already sub-tokenized) token is present in a document. */
function tokenPresent(token: string, docText: string, docWords: string[]): boolean {
  if (docText.includes(token)) return true;
  if (token.length < MORPH_MIN_PREFIX) return false;
  return docWords.some(
    word => word.length >= MORPH_MIN_PREFIX && sharedPrefixLength(word, token) >= MORPH_MIN_PREFIX
  );
}

function allTokensMatch(rawTokens: string[], docText: string, docWords: string[]): boolean {
  return rawTokens.flatMap(splitSubTokens).every(token => tokenPresent(token, docText, docWords));
}

function anyTokensMatch(rawTokens: string[], docText: string, docWords: string[]): boolean {
  return rawTokens.flatMap(splitSubTokens).some(token => tokenPresent(token, docText, docWords));
}

function docText(doc: CorpusDoc): string {
  return normalizeText(`${doc.name} ${doc.content}`);
}

function docWords(doc: CorpusDoc): string[] {
  return tokenizeWords(`${doc.name} ${doc.content}`);
}

function matchesSpec(doc: CorpusDoc, spec: MatchSpec): boolean {
  const text = docText(doc);
  const words = docWords(doc);
  switch (spec.kind) {
    case 'empty':
      return false;
    case 'all':
      return allTokensMatch(spec.tokens, text, words);
    case 'any':
      return anyTokensMatch(spec.tokens, text, words);
    case 'phrase':
      return text.includes(normalizeText(spec.phrase));
    case 'prefix': {
      const prefix = normalizeText(spec.prefix);
      return words.some(word => word.startsWith(prefix));
    }
    case 'substring':
      return text.includes(normalizeText(spec.text));
    case 'literal':
      // Exact folded substring(s) with NO morphological tolerance. Used for
      // corrected-term intent (typo cases), where MORPH_MIN_PREFIX would
      // over-include unrelated words sharing only a 4-char prefix.
      return spec.terms.some(term => text.includes(normalizeText(term)));
    case 'not':
      return (
        allTokensMatch(spec.include, text, words) && !anyTokensMatch(spec.exclude, text, words)
      );
  }
}

function matchesFilters(doc: CorpusDoc, params: CaseParams): boolean {
  if (params.space && doc.space !== params.space) return false;
  if (params.tier !== undefined && doc.tier !== params.tier) return false;
  return true;
}

/** Derive the sorted list of expected refs for a spec over a corpus. */
export function deriveExpected(
  corpus: CorpusDoc[],
  spec: MatchSpec,
  params: CaseParams = {}
): string[] {
  const refs: string[] = [];
  for (const doc of corpus) {
    if (!matchesFilters(doc, params)) continue;
    if (matchesSpec(doc, spec)) refs.push(refOf(doc.space, doc.name));
  }
  return sortRefs(refs);
}

/** Classify how many of the significant tokens are present across the corpus. */
export function classifyPresence(
  corpus: { name: string; content: string }[],
  tokens: string[]
): { presence: 'all-tokens-present' | 'partial' | 'absent'; hitCount: number } {
  const significant = tokens.map(normalizeText).filter(Boolean);
  if (significant.length === 0) return { presence: 'absent', hitCount: 0 };

  const perToken = significant.map(token =>
    corpus.some(doc => normalizeText(`${doc.name} ${doc.content}`).includes(token))
  );
  const present = perToken.filter(Boolean).length;
  if (present === significant.length) {
    const hitCount = corpus.filter(doc => {
      const text = normalizeText(`${doc.name} ${doc.content}`);
      return significant.every(token => text.includes(token));
    }).length;
    return { presence: 'all-tokens-present', hitCount };
  }
  if (present === 0) return { presence: 'absent', hitCount: 0 };
  return { presence: 'partial', hitCount: 0 };
}
