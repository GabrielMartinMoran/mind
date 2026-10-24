// @ts-check

/**
 * Pure search helpers: request building, confidence/methods labels, result
 * ranges and the semantic toggle policy. No DOM, no fetch.
 */

/** @typedef {'high' | 'medium' | 'low'} Confidence */
/** @typedef {1 | 2 | 3} Tier */
/**
 * @typedef {{
 *   q?: string | null,
 *   space?: string | null,
 *   spaceFilter?: string | null,
 *   tag?: string | null,
 *   tier?: Tier | number | null,
 *   tiers?: Tier[] | null,
 *   confidence?: Confidence | string | null,
 *   semantic?: boolean,
 *   limit?: number,
 *   offset?: number,
 * }} SearchState
 */
/**
 * @typedef {{
 *   q?: string,
 *   space: string,
 *   tag?: string,
 *   tier?: Tier,
 *   tiers?: string,
 *   confidence?: Confidence,
 *   semantic: boolean,
 *   limit: number,
 *   offset: number,
 * }} SearchRequest
 */

const DEFAULT_LIMIT = 30;
const KNOWN_CONFIDENCE = /** @type {Confidence[]} */ (['high', 'medium', 'low']);
const METHOD_LABELS = /** @type {Record<string, string>} */ ({
  phrase: 'Phrase',
  all: 'All terms',
  any: 'Any term',
  like: 'Like',
  trigram: 'Trigram',
  fuzzy: 'Fuzzy',
  token_set: 'Token set',
  semantic: 'Semantic',
});

/** @param {unknown} value @returns {value is Confidence} */
function isConfidence(value) {
  return typeof value === 'string' && KNOWN_CONFIDENCE.includes(/** @type {Confidence} */ (value));
}

/** @param {unknown} value @returns {value is Tier} */
function isTier(value) {
  return value === 1 || value === 2 || value === 3;
}

/**
 * Build the query params for a search request. Empty filters are omitted;
 * space, semantic, limit and offset always carry a value.
 *
 * @param {SearchState} [state]
 * @returns {SearchRequest}
 */
export function buildSearchRequest(state = {}) {
  /** @type {SearchRequest} */
  const request = {
    space: state.space || state.spaceFilter || '*',
    semantic: Boolean(state.semantic),
    limit: Number.isFinite(state.limit) ? /** @type {number} */ (state.limit) : DEFAULT_LIMIT,
    offset: Number.isFinite(state.offset) ? /** @type {number} */ (state.offset) : 0,
  };

  const q = typeof state.q === 'string' ? state.q.trim() : '';
  if (q) request.q = q;

  const tag = typeof state.tag === 'string' ? state.tag.trim() : '';
  if (tag) request.tag = tag;

  const tiers = Array.isArray(state.tiers) ? state.tiers.filter(isTier).sort((a, b) => a - b) : [];
  if (tiers.length === 1) request.tier = tiers[0];
  else if (tiers.length === 2) request.tiers = tiers.join(',');
  else if (isTier(state.tier)) request.tier = state.tier;
  if (isConfidence(state.confidence)) request.confidence = state.confidence;

  return request;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatConfidence(value) {
  if (value === 'high') return 'High confidence';
  if (value === 'medium') return 'Medium confidence';
  if (value === 'low') return 'Low confidence';
  return 'Unknown confidence';
}

/**
 * Map backend channel ids to human labels, preserving unknown ids as-is.
 *
 * @param {readonly string[] | null | undefined} methods
 * @returns {string[]}
 */
export function formatMethods(methods) {
  return (methods ?? []).map(method => METHOD_LABELS[method] ?? method);
}

/**
 * Compute the inclusive result range for the current page.
 *
 * @param {{ total?: number, limit?: number, offset?: number }} [options]
 * @returns {{ from: number, to: number, total: number, hasMore: boolean }}
 */
export function resultRange(options = {}) {
  const total = Number.isFinite(options.total)
    ? Math.max(0, /** @type {number} */ (options.total))
    : 0;
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, /** @type {number} */ (options.limit))
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(options.offset)
    ? Math.max(0, /** @type {number} */ (options.offset))
    : 0;

  if (total === 0) return { from: 0, to: 0, total, hasMore: false };

  return {
    from: Math.min(offset + 1, total),
    to: Math.min(offset + limit, total),
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Semantic search is opt-in and requires the server to have RAG enabled.
 *
 * @param {{ semantic?: boolean } | null | undefined} state
 * @param {boolean | null | undefined} ragEnabled
 * @returns {boolean}
 */
export function semanticEnabled(state, ragEnabled) {
  return Boolean(state?.semantic) && Boolean(ragEnabled);
}
