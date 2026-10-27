// @ts-check
/**
 * Pure search view renderers.
 *
 * `renderSearchView` builds the in-space filters, the announced status line,
 * flat result cards, skeletons, empty/error states and the load-more action.
 * Cards are real anchors with a stretched-link overlay; tag filters stay
 * outside the anchor so they never trigger navigation. Nothing here fetches,
 * reads globals or mutates state — app.js calls it with the controller state.
 */

import { tierParams } from '../domain/filter-model.js';
import { tierLabel } from '../domain/memory-model.js';
import { formatConfidence, formatMethods, resultRange } from '../domain/search-model.js';

import { createIcon } from './icon.js';

const DEFAULT_LIMIT = 30;
const SKELETON_CARDS = 3;
const SNIPPET_MAX_LENGTH = 240;
const KNOWN_CONFIDENCE = new Set(['high', 'medium', 'low']);
const OPERATORS = new Set(['and', 'or', 'not']);

/**
 * Monotonic counter for stable, unique score-explanation ids. Each render of a
 * card gets its own id, so repeated renders never collide in the document.
 */
let scoreHintSequence = 0;

/** @typedef {'high' | 'medium' | 'low'} Confidence */
/** @typedef {1 | 2 | 3} Tier */

/**
 * @typedef {Object} SearchFilters
 * @property {string} [space]
 * @property {string} [tag]
 * @property {Tier | number | null} [tier]
 * @property {Tier[]} [tiers]
 * @property {Confidence | string | null} [confidence]
 */

/**
 * @typedef {Object} SearchResultLike
 * @property {string} id
 * @property {string} space_name
 * @property {string} name
 * @property {string} [content]
 * @property {string} [snippet]
 * @property {number} [tier]
 * @property {Confidence | string} [confidence]
 * @property {string[]} [methods]
 * @property {number} [score]
 * @property {string[]} [tags]
 */

/**
 * @typedef {Object} SearchViewState
 * @property {string} [query]
 * @property {SearchFilters} [filters]
 * @property {boolean} [semantic]
 * @property {SearchResultLike[]} [results]
 * @property {number} [total]
 * @property {boolean} [hasMore]
 * @property {'idle' | 'loading' | 'success' | 'error'} [status]
 * @property {string | null} [error]
 * @property {number} [offset]
 * @property {number} [limit]
 * @property {boolean | null} [ragEnabled]
 * @property {{ name?: string } | null} [currentSpace]
 */

/**
 * @typedef {Object} SearchViewHandlers
 * @property {(name: string, value: string | number | null) => void} [onFilterChange]
 * @property {(enabled: boolean) => void} [onSemanticChange]
 * @property {() => void} [onClearQuery]
 * @property {() => void} [onClearAll]
 * @property {() => void} [onRetry]
 * @property {() => void} [onLoadMore]
 * @property {(result: SearchResultLike) => void} [onOpenResult]
 */

/**
 * @typedef {Object} CardOptions
 * @property {string} [href]
 * @property {string} [query]
 * @property {SearchFilters} [filters]
 * @property {boolean} [semantic]
 * @property {(result: SearchResultLike) => void} [onOpenResult]
 */

/**
 * Create an element with an optional class and text content.
 *
 * @param {string} tagName
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract literal query terms suitable for highlighting. Operators are
 * skipped, quotes and a trailing prefix wildcard are stripped.
 *
 * @param {string | null | undefined} query
 * @returns {string[]}
 */
function queryTerms(query) {
  if (typeof query !== 'string' || query.trim() === '') return [];

  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  /** @type {string[]} */
  const terms = [];
  for (const token of tokens) {
    if (OPERATORS.has(token.toLowerCase())) continue;
    const cleaned = token
      .replace(/^"+|"+$/g, '')
      .replace(/\*+$/, '')
      .trim();
    if (cleaned && !terms.includes(cleaned)) terms.push(cleaned);
  }
  // Longest first so "authentication" wins over "auth".
  return terms.sort((a, b) => b.length - a.length);
}

/**
 * Split `text` into text nodes and `<mark>` nodes for every query term.
 * Using text nodes only keeps arbitrary user content inert.
 *
 * @param {string} text
 * @param {readonly string[]} terms
 * @returns {DocumentFragment}
 */
function highlightMatches(text, terms) {
  const fragment = document.createDocumentFragment();
  if (terms.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
    }
    const mark = element('mark', 'search-highlight', match[0]);
    fragment.appendChild(mark);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

/**
 * @param {SearchResultLike} result
 * @returns {string}
 */
function snippetText(result) {
  const raw =
    typeof result.snippet === 'string'
      ? result.snippet
      : typeof result.content === 'string'
        ? result.content
        : '';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= SNIPPET_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * @param {number | undefined} tier
 * @returns {string}
 */
function tierClass(tier) {
  return tier === 1 || tier === 2 || tier === 3 ? `t${tier}` : '';
}

/**
 * @param {unknown} confidence
 * @returns {string}
 */
function confidenceClass(confidence) {
  return typeof confidence === 'string' && KNOWN_CONFIDENCE.has(confidence)
    ? `confidence-${confidence}`
    : '';
}

/**
 * Build the memory URL, preserving the active query and filters so the panel
 * can restore the search.
 *
 * @param {SearchResultLike} result
 * @param {CardOptions} [options]
 * @returns {string}
 */
function buildResultHref(result, options = {}) {
  const base = `/spaces/${encodeURIComponent(result.space_name)}?memory=${encodeURIComponent(result.name)}`;
  /** @type {string[]} */
  const params = [];

  const query = typeof options.query === 'string' ? options.query.trim() : '';
  if (query) params.push(`q=${encodeURIComponent(query)}`);

  const filters = options.filters ?? {};
  const tag = typeof filters.tag === 'string' ? filters.tag.trim() : '';
  if (tag) params.push(`tag=${encodeURIComponent(tag)}`);

  const tiers = Array.isArray(filters.tiers) ? filters.tiers : [];
  const { tier, tiers: tierList } = tierParams(
    tiers.length > 0 ? tiers : filters.tier != null ? [filters.tier] : []
  );
  if (tier) params.push(`tier=${tier}`);
  if (tierList) params.push(`tiers=${tierList}`);

  const confidence = filters.confidence;
  if (confidence === 'high' || confidence === 'medium' || confidence === 'low') {
    params.push(`confidence=${confidence}`);
  }

  if (options.semantic === true) params.push('semantic=on');

  return params.length > 0 ? `${base}&${params.join('&')}` : base;
}

/**
 * @param {string} id
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function createButton(id, className, text) {
  const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  button.type = 'button';
  button.id = id;
  button.className = className;
  button.textContent = text;
  return button;
}

/**
 * Build one result card. The anchor link covers the card through a CSS
 * stretched-link pseudo-element; tags are passive data chips outside the anchor.
 *
 * @param {SearchResultLike} result
 * @param {CardOptions} [options]
 * @returns {HTMLElement}
 */
export function createSearchResultCard(result, options = {}) {
  const card = /** @type {HTMLElement} */ (document.createElement('article'));
  card.className = 'search-result';

  const anchor = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
  anchor.className = 'search-result-link';
  anchor.href = options.href ?? buildResultHref(result, options);

  anchor.appendChild(element('span', 'search-result-name', result.name));

  const snippet = element('p', 'search-result-snippet');
  snippet.appendChild(highlightMatches(snippetText(result), queryTerms(options.query)));
  anchor.appendChild(snippet);

  const meta = element('div', 'search-result-meta');

  if (result.tier === 1 || result.tier === 2 || result.tier === 3) {
    const badge = element('span', `tier-badge ${tierClass(result.tier)}`, `T${result.tier}`);
    badge.title = tierLabel(result.tier);
    meta.appendChild(badge);
  }

  if (result.confidence) {
    meta.appendChild(
      element(
        'span',
        `confidence-badge ${confidenceClass(result.confidence)}`,
        formatConfidence(result.confidence)
      )
    );
  }

  const methods = formatMethods(result.methods);
  if (methods.length > 0) {
    meta.appendChild(element('span', 'search-result-methods', `Matched by: ${methods.join(', ')}`));
  }

  if (typeof result.score === 'number' && Number.isFinite(result.score)) {
    const score = element('span', 'search-result-score', `Score ${result.score.toFixed(2)}`);
    const hintId = `search-score-hint-${++scoreHintSequence}`;
    score.setAttribute('aria-describedby', hintId);
    meta.appendChild(score);

    // The score is normalized per query, not calibrated across queries. The
    // hint is visible (not title-only) so touch, keyboard and AT users all get
    // the same explanation, and `aria-describedby` ties it to the value.
    const hint = element('span', 'search-result-score-hint', 'Relative to this search');
    hint.id = hintId;
    meta.appendChild(hint);
  }

  // A quiet open affordance; the whole card stays one anchor, so the icon is
  // decorative and never a second control.
  const open = element('span', 'search-result-open');
  open.appendChild(createIcon('chevron-right', { size: 'sm' }));
  meta.appendChild(open);

  anchor.appendChild(meta);
  card.appendChild(anchor);

  const tags = result.tags ?? [];
  if (tags.length > 0) {
    // Tags are descriptive data, not actions: filtering happens in the shared
    // select. Plain spans keep them out of the tab order and out of the URL.
    const tagRow = element('div', 'search-result-tags');
    for (const tag of tags) {
      tagRow.appendChild(element('span', 'search-result-tag', `#${tag}`));
    }
    card.appendChild(tagRow);
  }

  if (options.onOpenResult) {
    anchor.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      options.onOpenResult?.(result);
    });
  }

  return card;
}

/**
 * @param {readonly SearchResultLike[]} results
 * @param {CardOptions} options
 * @returns {HTMLUListElement}
 */
function renderResultList(results, options) {
  const list = /** @type {HTMLUListElement} */ (document.createElement('ul'));
  list.className = 'search-result-list';

  for (const result of results) {
    const item = /** @type {HTMLLIElement} */ (document.createElement('li'));
    item.className = 'search-result-item';
    item.appendChild(createSearchResultCard(result, options));
    list.appendChild(item);
  }
  return list;
}

/**
 * @param {SearchViewState} state
 * @param {SearchViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderResults(state, handlers) {
  const results = state.results ?? [];
  /** @type {CardOptions} */
  const cardOptions = {
    query: state.query ?? '',
    filters: state.filters ?? {},
    semantic: state.semantic === true,
    onOpenResult: handlers.onOpenResult,
  };

  return renderResultList(results, cardOptions);
}

/**
 * @returns {HTMLElement}
 */
function renderSkeleton() {
  const list = element('div', 'search-skeleton-list');
  list.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < SKELETON_CARDS; index += 1) {
    const card = element('div', 'search-skeleton');
    card.appendChild(element('div', 'skeleton search-skeleton-title'));
    card.appendChild(element('div', 'skeleton search-skeleton-meta'));
    card.appendChild(element('div', 'skeleton search-skeleton-line'));
    card.appendChild(element('div', 'skeleton search-skeleton-line search-skeleton-line-short'));
    list.appendChild(card);
  }

  return list;
}

/**
 * @returns {HTMLElement}
 */
function renderEmpty() {
  const empty = element('div', 'search-empty');
  empty.appendChild(
    element(
      'p',
      'search-empty-message',
      'No memories match these filters. Try a broader query or clear filters above.'
    )
  );
  return empty;
}

/**
 * @param {SearchViewState} state
 * @param {SearchViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderError(state, handlers) {
  const block = element('div', 'search-error');
  block.setAttribute('role', 'alert');
  block.appendChild(
    element('p', 'search-error-message', state.error || 'The search could not complete. Try again.')
  );
  const retry = createButton('search-retry', 'btn btn-sm btn-secondary search-retry', 'Try again');
  retry.prepend(createIcon('rotate-ccw'));
  retry.addEventListener('click', () => handlers.onRetry?.());
  block.appendChild(retry);
  return block;
}

/**
 * Render only the results body (skeletons, error, empty or cards + load more).
 * The composition layer swaps this subtree while keeping the surrounding
 * filter bar, live region and region element stable.
 *
 * @param {SearchViewState} [state]
 * @param {SearchViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderSearchResults(state = {}, handlers = {}) {
  const results = state.results ?? [];

  if (state.status === 'error') return renderError(state, handlers);
  if (state.status === 'loading' && results.length === 0) return renderSkeleton();
  if (results.length === 0) return renderEmpty();

  const wrapper = element('div', 'search-results-content');
  wrapper.appendChild(renderResults(state, handlers));

  if (state.hasMore) {
    const loadMore = createButton(
      'search-load-more',
      'btn btn-sm btn-secondary search-load-more',
      'Load more'
    );
    loadMore.prepend(createIcon('chevron-down'));
    loadMore.disabled = state.status === 'loading';
    loadMore.addEventListener('click', () => handlers.onLoadMore?.());
    wrapper.appendChild(loadMore);
  }

  return wrapper;
}

/**
 * Build the polite status line text for the current page of results.
 *
 * @param {SearchViewState} [state]
 * @returns {string}
 */
export function formatSearchStatus(state = {}) {
  const isLoading = state.status === 'loading';
  const total = Number.isFinite(state.total) ? Math.max(0, Number(state.total)) : 0;
  const limit = Number.isFinite(state.limit) ? Number(state.limit) : DEFAULT_LIMIT;
  const offset = Number.isFinite(state.offset) ? Math.max(0, Number(state.offset)) : 0;
  const range = resultRange({ total, limit, offset });
  const hasResults = (state.results?.length ?? 0) > 0;

  if (isLoading && !hasResults) return 'Searching…';
  if (total === 0) return '0 results';
  if (range.from === 1 && range.to === total) {
    return `${total} ${total === 1 ? 'result' : 'results'}`;
  }
  return `Showing ${range.from}–${range.to} of ${total} results`;
}

/**
 * Render the whole search surface for the existing `#search-results`
 * container. The shell owns the `h1` (`#search-heading`), so the returned
 * section references it with `aria-labelledby` instead of adding a heading.
 *
 * Kept for full-surface rendering and backward compatibility; the incremental
 * page composition swaps `renderSearchResults` and `formatSearchStatus` while the
 * shell-owned filter bar stays mounted, so filters and the live region survive
 * updates.
 *
 * @param {SearchViewState} [state]
 * @param {SearchViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderSearchView(state = {}, handlers = {}) {
  const isLoading = state.status === 'loading';

  const section = element('section', 'search-view');
  section.setAttribute('aria-labelledby', 'space-title');

  const region = element('div', 'search-results-region');
  region.id = 'search-results-region';
  region.setAttribute('aria-busy', String(isLoading));

  const status = element('p', 'search-status', formatSearchStatus(state));
  status.id = 'search-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-busy', String(isLoading));
  region.appendChild(status);

  region.appendChild(renderSearchResults(state, handlers));
  section.appendChild(region);

  return section;
}
