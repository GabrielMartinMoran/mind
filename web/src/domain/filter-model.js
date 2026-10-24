// @ts-check

/**
 * Pure filter state for the open-space experience. This module owns the tier
 * vocabulary and the URL/request serialization rules shared by routing, the
 * list view and in-space search. It has no DOM or I/O dependencies.
 */

/** @typedef {1|2|3} Tier */
/** @typedef {'high'|'medium'|'low'} Confidence */
/**
 * Shared filter state. `tiers` holds the selected tiers; selecting all three is
 * the same as no tier filter. `onlyMatches` is a map-only view flag and is not
 * serialized to the URL.
 *
 * @typedef {{
 *   q: string,
 *   tag: string,
 *   tiers: Tier[],
 *   confidence: ''|Confidence,
 *   semantic: boolean,
 *   onlyMatches: boolean,
 * }} FilterState
 */
/** @typedef {{ tier?: string, tiers?: string }} TierParams */

/** @type {readonly Tier[]} */
export const ALL_TIERS = Object.freeze([1, 2, 3]);

/**
 * @param {unknown} value
 * @returns {value is Tier}
 */
function isTier(value) {
  return value === 1 || value === 2 || value === 3;
}

/**
 * Normalize any tier input (array or comma-separated string) into a sorted,
 * duplicate-free list of valid tiers. Unknown values are dropped; an empty
 * result means "no tier filter" (all tiers).
 *
 * @param {unknown} input
 * @returns {Tier[]}
 */
export function normalizeTiers(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  /** @type {Set<Tier>} */
  const seen = new Set();
  for (const item of raw) {
    const value = typeof item === 'string' ? Number(item.trim()) : item;
    if (isTier(value)) seen.add(value);
  }
  return /** @type {Tier[]} */ ([...seen].sort((a, b) => a - b));
}

/**
 * Whether a selection represents "all tiers" (empty or the full set).
 *
 * @param {unknown} tiers
 * @returns {boolean}
 */
export function isAllTiers(tiers) {
  const normalized = normalizeTiers(tiers);
  return normalized.length === 0 || normalized.length === ALL_TIERS.length;
}

/**
 * Serialize a selection for a query string. One tier keeps the legacy
 * `tier=N` contract; two tiers use `tiers=N,M`; all or none omit both.
 *
 * @param {unknown} tiers
 * @returns {TierParams}
 */
export function tierParams(tiers) {
  const normalized = normalizeTiers(tiers);
  if (normalized.length === 1) return { tier: String(normalized[0]) };
  if (normalized.length === 2) return { tiers: normalized.join(',') };
  return {};
}

/**
 * @param {FilterState} filters
 * @returns {boolean}
 */
export function hasActiveFilters(filters) {
  return (
    filters.q.trim() !== '' ||
    filters.tag.trim() !== '' ||
    !isAllTiers(filters.tiers) ||
    filters.confidence !== '' ||
    filters.semantic ||
    filters.onlyMatches
  );
}

/**
 * Default filter state: no query, no tag, every tier active.
 *
 * @returns {FilterState}
 */
export function clearFilters() {
  return {
    q: '',
    tag: '',
    tiers: [...ALL_TIERS],
    confidence: '',
    semantic: false,
    onlyMatches: false,
  };
}

/**
 * Request params for the metadata/list query (`/api/memories/query`).
 *
 * @param {FilterState} filters
 * @returns {{ tag?: string, tier?: string, tiers?: string }}
 */
export function toListQuery(filters) {
  return {
    tag: filters.tag.trim() || undefined,
    ...tierParams(filters.tiers),
  };
}

/**
 * Request params for in-space search (`/api/search`). `semantic` is always
 * explicit so the server does not fall back to its RAG default.
 *
 * @param {FilterState} filters
 * @returns {{ q: string, tag?: string, tier?: string, tiers?: string, confidence?: Confidence, semantic: 'on'|'off' }}
 */
export function toSearchRequest(filters) {
  return {
    q: filters.q,
    tag: filters.tag.trim() || undefined,
    ...tierParams(filters.tiers),
    confidence: filters.confidence || undefined,
    semantic: filters.semantic ? 'on' : 'off',
  };
}
