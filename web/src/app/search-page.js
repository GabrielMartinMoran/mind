// @ts-check
/**
 * Search page composition layer.
 *
 * The shared filter bar lives in the static shell header, so this page only
 * owns the results surface: a persistent results region and polite
 * `#search-status` live region. It re-renders the results subtree when the
 * store changes while keeping the status node identity stable.
 *
 * It performs no fetching, imports no app shell and owns no global state; the
 * controller coordinates async work and the URL, views stay pure.
 */

import { formatSearchStatus, renderSearchResults } from '../views/search-view.js';

/**
 * @typedef {Object} SearchPageOptions
 * @property {HTMLElement} [root] Container that receives the page.
 * @property {{
 *   getState: () => any,
 *   subscribe: (listener: (state: any) => void) => () => void,
 * }} [store] Observable app store with a `search` slice.
 * @property {any} [controller] Search controller (retry/loadMore/...).
 * @property {() => any} [getStatus] Reads status, including `rag_enabled`.
 * @property {(result: any) => void} [onOpenResult] Opens a result elsewhere.
 * @property {(tag: string) => void} [onTagClick] Applies a tag filter.
 * @property {Document} [document] Document used to create page nodes.
 */

/**
 * @typedef {Object} SearchPage
 * @property {() => HTMLElement | undefined} mount
 * @property {() => void} update
 * @property {() => void} destroy
 */

const ID_PREFIX = 'id:';
const HREF_PREFIX = 'href:';
const TAG_PREFIX = 'tag:';

/**
 * @param {Element | null} node
 * @returns {string | null}
 */
function focusKey(node) {
  if (!node) return null;
  if (node.id) return `${ID_PREFIX}${node.id}`;

  const href = node.getAttribute('href');
  if (href) return `${HREF_PREFIX}${href}`;

  const tag = node.getAttribute('data-tag-filter');
  if (tag) return `${TAG_PREFIX}${tag}`;

  return null;
}

/**
 * @param {SearchPageOptions} [options]
 * @returns {SearchPage}
 */
export function createSearchPage(options = {}) {
  const { root, store, controller, onOpenResult, onTagClick } = options;
  const doc = options.document ?? globalThis.document;

  let mounted = false;
  let destroyed = false;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {HTMLElement | null} */
  let resultsRegion = null;
  /** @type {HTMLElement | null} */
  let statusNode = null;
  /** @type {HTMLElement | null} */
  let resultsBody = null;

  /** Handlers are bound once so the page never needs to be rebuilt. */
  const handlers = {
    onRetry: () => controller?.retry?.(),
    onLoadMore: () => controller?.loadMore?.(),
    /** @param {string} tag */
    onTagClick: tag => onTagClick?.(tag),
    /** @param {any} result */
    onOpenResult: result => onOpenResult?.(result),
  };

  /** @returns {any} */
  function buildViewState() {
    const appState = store?.getState?.() ?? {};
    const search = appState.search ?? {};
    return {
      ...search,
      currentSpace: search.currentSpace ?? appState.currentSpace ?? null,
    };
  }

  /** @param {string} key @returns {HTMLElement | null} */
  function findElementByKey(key) {
    if (!root) return null;

    if (key.startsWith(ID_PREFIX)) {
      return doc.getElementById(key.slice(ID_PREFIX.length));
    }

    if (key.startsWith(HREF_PREFIX)) {
      const href = key.slice(HREF_PREFIX.length);
      for (const node of root.querySelectorAll('a[href]')) {
        if (node.getAttribute('href') === href) return /** @type {HTMLElement} */ (node);
      }
      return null;
    }

    if (key.startsWith(TAG_PREFIX)) {
      const tag = key.slice(TAG_PREFIX.length);
      for (const node of root.querySelectorAll('[data-tag-filter]')) {
        if (node.getAttribute('data-tag-filter') === tag) return /** @type {HTMLElement} */ (node);
      }
    }

    return null;
  }

  /**
   * Keep focus stable: a focused node inside the replaced results body is
   * restored by a stable key; if it disappeared focus moves to the results
   * region instead of a detached element.
   *
   * @param {Element | null} active
   * @param {boolean} focusWasInResults
   */
  function restoreFocus(active, focusWasInResults) {
    if (!focusWasInResults || !active || active.isConnected !== false) return;

    const key = focusKey(active);
    const replacement = key ? findElementByKey(key) : null;
    if (replacement) {
      replacement.focus();
    } else {
      resultsRegion?.focus();
    }
  }

  /** @param {any} viewState */
  function applyState(viewState) {
    if (!resultsRegion || !statusNode || !resultsBody) return;

    const active = doc.activeElement;
    const focusWasInResults = Boolean(active && resultsBody.contains(active));

    const busy = viewState.status === 'loading';
    const statusText = formatSearchStatus(viewState);
    if (statusNode.textContent !== statusText) statusNode.textContent = statusText;
    statusNode.setAttribute('aria-busy', String(busy));
    resultsRegion.setAttribute('aria-busy', String(busy));
    resultsBody.replaceChildren(renderSearchResults(viewState, handlers));

    restoreFocus(active, focusWasInResults);
  }

  function update() {
    if (!mounted || destroyed) return;
    applyState(buildViewState());
  }

  function mount() {
    if (!root || mounted || destroyed) return root;
    mounted = true;

    resultsRegion = doc.createElement('div');
    resultsRegion.id = 'search-results-region';
    resultsRegion.className = 'search-results-region';
    resultsRegion.tabIndex = -1;

    statusNode = doc.createElement('p');
    statusNode.id = 'search-status';
    statusNode.className = 'search-status';
    statusNode.setAttribute('role', 'status');
    statusNode.setAttribute('aria-live', 'polite');

    resultsBody = doc.createElement('div');
    resultsBody.className = 'search-results-body';

    resultsRegion.appendChild(statusNode);
    resultsRegion.appendChild(resultsBody);
    root.replaceChildren(resultsRegion);

    applyState(buildViewState());
    unsubscribe = store?.subscribe?.(() => update()) ?? null;

    return root;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    if (!mounted) return;
    mounted = false;
    resultsRegion = null;
    statusNode = null;
    resultsBody = null;
    root?.replaceChildren();
  }

  return { mount, update, destroy };
}
