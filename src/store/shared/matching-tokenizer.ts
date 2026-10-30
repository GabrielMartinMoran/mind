// ── Shared matching tokenizer (D11) ──
//
// Single source of truth for lexical matching across search: fold case and
// accents, then split on non-alphanumerics AND camelCase / acronym boundaries.
// Used by the query parser and relaxation rungs now; the token-set, fuzzy and
// trigram channels reuse it in later tasks.

const DIACRITICS = /[\u0300-\u036f]/g;
const LOWER_UPPER_BOUNDARY = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;
const LATIN_WITH_DIACRITICS = /[À-ɏḀ-ỿ]/g;

/** Remove combining diacritics (`acción` → `accion`). */
export function stripDiacritics(text: string): string {
  // Fold only Latin letters, like SQLite unicode61/trigram remove_diacritics:
  // folding Cyrillic й/ё here would turn them into и/е, which the index keeps.
  return text.replace(LATIN_WITH_DIACRITICS, ch => ch.normalize('NFD').replace(DIACRITICS, ''));
}

/** Split camelCase and acronym boundaries into separate words. */
function splitIdentifierBoundaries(text: string): string {
  return text.replace(LOWER_UPPER_BOUNDARY, '$1 $2').replace(ACRONYM_BOUNDARY, '$1 $2');
}

/**
 * Normalize a single token: fold to lowercase and strip diacritics, keeping the
 * token intact (no splitting). Phrase matching uses this to preserve semantics.
 */
export function normalizeToken(token: string): string {
  return stripDiacritics(token).toLowerCase();
}

/**
 * Tokenize text into folded matching tokens.
 *
 * @example
 * tokenize('Configuración-tempHP_2026')
 * // => ['configuracion', 'temp', 'hp', '2026']
 */
export function tokenize(text: string): string[] {
  return splitIdentifierBoundaries(stripDiacritics(text))
    .toLowerCase()
    .split(NON_ALPHANUMERIC)
    .filter(Boolean);
}

/**
 * Folded vocabulary of a document: raw normalized words (kept intact, so
 * camelCase identifiers stay one term) plus tokenizer sub-words (so multi-word
 * identifier queries can expand per part). Single shared engine fold: the fuzzy
 * channel builds both its candidate vocabulary and its per-document coverage
 * with this so they can never drift.
 */
export function foldedWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of normalizeToken(text).split(/[^a-z0-9]+/)) {
    if (raw) words.add(raw);
  }
  for (const token of tokenize(text)) words.add(token);
  return words;
}

// ── Per-store generation counter (P-A cache-invalidation seam) ──
//
// The fuzzy channel caches the folded document vocabulary in memory (P-A) so a
// steady-state search pays no per-query document re-fold. Every document write
// bumps the generation for that Database handle, so the next search reloads.
// The counter is keyed weakly by the handle, so it costs nothing to keep and
// cannot leak across stores.

import type { Database } from 'bun:sqlite';

const STORE_GENERATIONS = new WeakMap<object, number>();

/** Monotonic write generation of a Database handle (0 before any write). */
export function storeGeneration(db: object): number {
  return STORE_GENERATIONS.get(db) ?? 0;
}

/** Mark the in-memory document vocabulary cache of a handle stale. */
export function bumpStoreGeneration(db: object): void {
  STORE_GENERATIONS.set(db, storeGeneration(db) + 1);
}

/**
 * Cross-connection change counter read on THIS connection via
 * `PRAGMA data_version`.
 *
 * SQLite advances it whenever another connection/process commits a change to
 * the database file, and deliberately leaves it unchanged for writes made by
 * this same connection (those are covered by {@link storeGeneration}).
 * Combined, `{ generation, dataVersion }` is a complete validity key for the
 * in-memory document-vocabulary cache: a local write bumps the generation, an
 * external write bumps `data_version`, and the cache can never stay
 * permanently stale.
 *
 * Returns 0 if the pragma is unavailable (defensive), so the cache then falls
 * back to local-generation invalidation only.
 */
export function dataVersion(db: object): number {
  try {
    const row = (db as Database).query('PRAGMA data_version').get() as {
      data_version: number;
    } | null;
    return row?.data_version ?? 0;
  } catch {
    return 0;
  }
}
