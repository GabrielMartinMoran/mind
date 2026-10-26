// ── Supplied-search validation error ──
//
// A search invocation whose positive query text contains no informative term
// after common stopwords are removed is a caller mistake, not an empty result.
// One typed error and one actionable message are shared by every surface so the
// store choke point stays the single source of truth.

/** Stable machine-readable code for an empty/all-stopword search query. */
export const EMPTY_SEARCH_QUERY_CODE = 'empty_search_query';

/**
 * Actionable message returned when a supplied search has no informative terms.
 * It intentionally never echoes the rejected raw query.
 */
export const EMPTY_SEARCH_QUERY_MESSAGE =
  'Search has no informative terms after common words are removed. Add a specific topic, name, or identifier and try again.';

/**
 * Validation error raised for a supplied search whose positive query text is
 * empty after common stopwords are removed. Adapters translate this to their own
 * validation response; unrelated failures must never be caught as this type.
 */
export class EmptySearchQueryError extends Error {
  readonly code = EMPTY_SEARCH_QUERY_CODE;

  constructor() {
    super(EMPTY_SEARCH_QUERY_MESSAGE);
    this.name = 'EmptySearchQueryError';
  }
}
