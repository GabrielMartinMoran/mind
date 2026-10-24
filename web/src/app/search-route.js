// @ts-check
/**
 * Search route resolution.
 *
 * Pure helpers that decide which search surface a parsed route shows and how a
 * search result maps back to a canonical memory URL. They perform no DOM,
 * network or store work: app.js applies the decision, the controller owns the
 * URL and the views render from the store.
 */

import { buildAppUrl } from '../features/routing/routing.js';

/**
 * @typedef {'high' | 'medium' | 'low'} Confidence
 * @typedef {1 | 2 | 3} Tier
 */

/**
 * Minimal shape of a parsed route (`parseAppRoute`) used by these helpers.
 *
 * @typedef {Object} SearchRouteLike
 * @property {string | null} [spaceName]
 * @property {boolean} [isLogsPage]
 * @property {string} [q]
 * @property {string} [tag]
 * @property {Tier | number | null} [tier]
 * @property {Confidence | string | null} [confidence]
 * @property {boolean} [semantic]
 */

/**
 * @typedef {Object} SearchViewResolution
 * @property {boolean} showSearch True when the search surface should be visible.
 * @property {boolean} spaceMode True for a single-space search.
 * @property {{ name: string } | null} currentSpace Space that scopes the search.
 */

/**
 * @typedef {Object} SearchResultLike
 * @property {string} space_name
 * @property {string} name
 */

/**
 * @typedef {Object} SearchStateLike
 * @property {string} [query]
 * @property {{
 *   space?: string,
 *   tag?: string | null,
 *   tier?: Tier | number | null,
 *   confidence?: Confidence | string | null,
 * } | null} [filters]
 * @property {boolean} [semantic]
 */

/**
 * Criteria that make a route a search. On a space route only a query or a
 * confidence filter opens the search surface; `tier` and `tag` alone are the
 * memory list's filter state. `semantic` alone is a mode switch, not a
 * criterion, so it never turns a space route into a search.
 *
 * @param {SearchRouteLike | null | undefined} route
 * @returns {boolean}
 */
export function hasSearchCriteria(route) {
  if (!route) return false;

  const query = typeof route.q === 'string' ? route.q.trim() : '';
  const confidence = route.confidence;

  return Boolean(query || confidence === 'high' || confidence === 'medium' || confidence === 'low');
}

/**
 * Decide which surface a route shows.
 *
 * - `/spaces/{space}` shows the space-scoped search surface when the route
 *   carries a query or confidence filter; `tier`/`tag` alone stay on the
 *   space detail/list view.
 * - Everything else (home, logs) never shows search.
 *
 * @param {SearchRouteLike | null | undefined} route
 * @returns {SearchViewResolution}
 */
export function resolveSearchView(route) {
  if (route?.spaceName && hasSearchCriteria(route)) {
    return { showSearch: true, spaceMode: true, currentSpace: { name: route.spaceName } };
  }

  return { showSearch: false, spaceMode: false, currentSpace: null };
}

/**
 * Build the canonical URL for a search result. It opens the memory and keeps
 * the active query, filters and embeddings mode so Back returns to the same
 * search. Encoding rules stay in `buildAppUrl`.
 *
 * @param {SearchResultLike} result
 * @param {SearchStateLike} [searchState]
 * @returns {string}
 */
export function buildResultUrl(result, searchState = {}) {
  const filters = searchState.filters ?? {};
  const query = typeof searchState.query === 'string' ? searchState.query.trim() : '';

  return buildAppUrl({
    spaceName: result.space_name,
    view: 'list',
    memoryName: result.name,
    q: query,
    tag: filters.tag ?? '',
    tier: filters.tier ?? null,
    confidence: filters.confidence ?? null,
    semantic: searchState.semantic === true,
  });
}
