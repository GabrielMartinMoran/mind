// @ts-check
/**
 * Client-side filtering for the All spaces overview.
 *
 * Pure helpers: no DOM, no fetching. The home search runs entirely over the
 * already-loaded visible spaces, so typing never reaches the memory backend.
 */

/**
 * @typedef {Object} SpaceLike
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {boolean} [hidden]
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Fold text to a comparable form: decomposed Unicode, combining marks removed,
 * then lowercase. This makes name/description/tag matching case- and
 * accent-insensitive in both directions.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

/**
 * Split a query into folded, non-empty tokens.
 *
 * @param {string} query
 * @returns {string[]}
 */
function queryTokens(query) {
  return normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
}

/**
 * Build one searchable haystack from the space's name, description and tags.
 *
 * @param {SpaceLike} space
 * @returns {string}
 */
function spaceHaystack(space) {
  const tags = Array.isArray(space.tags) ? space.tags : [];
  return normalizeSearchText([space.name, space.description ?? '', ...tags].join(' '));
}

/**
 * True when every whitespace-separated query token appears somewhere in the
 * space's name, description or tags. An empty query matches every space.
 *
 * @param {SpaceLike} space
 * @param {string} query
 * @returns {boolean}
 */
export function matchesSpaceQuery(space, query) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;

  const haystack = spaceHaystack(space);
  return tokens.every(token => haystack.includes(token));
}

/**
 * Keep visible spaces that match the query. Hidden spaces never appear on the
 * All spaces overview, even when the sidebar is showing hidden spaces.
 *
 * @param {readonly SpaceLike[] | undefined | null} spaces
 * @param {string} query
 * @returns {SpaceLike[]}
 */
export function filterVisibleSpaces(spaces, query) {
  return (spaces ?? []).filter(space => !space.hidden && matchesSpaceQuery(space, query));
}
