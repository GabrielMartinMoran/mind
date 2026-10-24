// @ts-check

import { buildSearchRequest, semanticEnabled } from '../domain/search-model.js';
import { parseAppRoute } from '../features/routing/routing.js';

/**
 * Search controller: the only place that coordinates the search API, the
 * observable store and the URL. It performs no DOM work, so views can render
 * from the store and tests can inject history, location, timers and events.
 */

/** @typedef {'idle' | 'loading' | 'success' | 'error'} SearchStatus */
/** @typedef {'high' | 'medium' | 'low'} Confidence */
/** @typedef {1 | 2 | 3} Tier */
/**
 * @typedef {{
 *   space: string,
 *   tag: string,
 *   tier: Tier | null,
 *   tiers: Tier[],
 *   confidence: Confidence | null,
 * }} SearchFilters
 */
/**
 * @typedef {{
 *   query: string,
 *   filters: SearchFilters,
 *   semantic: boolean,
 *   results: unknown[],
 *   total: number,
 *   hasMore: boolean,
 *   status: SearchStatus,
 *   error: string | null,
 *   offset: number,
 * }} SearchSlice
 */
/**
 * @typedef {{
 *   q?: string,
 *   space?: string,
 *   tag?: string,
 *   tier?: Tier,
 *   tiers?: string,
 *   confidence?: Confidence,
 *   semantic?: 'on' | 'off',
 *   limit?: number,
 *   offset?: number,
 * }} SearchPayload
 */
/** @typedef {{ results: unknown[], total: number, hasMore: boolean }} SearchApiResponse */
/**
 * @typedef {(
 *   payload: SearchPayload,
 *   requestOptions: { signal?: AbortSignal },
 * ) => Promise<SearchApiResponse>} SearchApi
 */
/**
 * @typedef {{
 *   getState: () => any,
 *   setState: (patch: any) => any,
 * }} StoreLike
 */
/**
 * @typedef {{
 *   pushState: (state: unknown, title: string, url: string) => void,
 *   replaceState: (state: unknown, title: string, url: string) => void,
 * }} HistoryLike
 */
/** @typedef {{ pathname: string, search: string }} LocationLike */
/**
 * @typedef {{
 *   addEventListener?: (type: string, listener: () => void) => void,
 *   removeEventListener?: (type: string, listener: () => void) => void,
 * }} EventTargetLike
 */
/**
 * @typedef {{
 *   store: StoreLike,
 *   searchApi: SearchApi,
 *   history?: HistoryLike,
 *   location?: LocationLike,
 *   eventTarget?: EventTargetLike | null,
 *   debounceMs?: number,
 *   setTimeout?: (handler: () => void, timeout?: number) => unknown,
 *   clearTimeout?: (id: any) => void,
 * }} SearchControllerOptions
 */

const DEFAULT_LIMIT = 30;

/** @returns {SearchSlice} */
function createInitialSearchState() {
  return {
    query: '',
    filters: { space: '*', tag: '', tier: null, tiers: [], confidence: null },
    semantic: false,
    results: [],
    total: 0,
    hasMore: false,
    status: 'idle',
    error: null,
    offset: 0,
  };
}

/**
 * Whether the controller has enough state to call the API.
 *
 * This deliberately includes an explicit space filter: `setFilter('space', …)`
 * must run a search even with an empty query. It is not the same predicate as
 * `hasSearchCriteria` in `search-route.js`, which asks whether a *route* carries
 * a search; a space route already scopes by path, so its space is not a
 * criterion there.
 *
 * @param {string} query
 * @param {SearchFilters} filters
 */
function hasActiveSearch(query, filters) {
  return Boolean(
    query.trim() ||
    filters.tag ||
    (Array.isArray(filters.tiers) && filters.tiers.length > 0 && filters.tiers.length < 3) ||
    filters.tier !== null ||
    filters.confidence !== null ||
    (filters.space && filters.space !== '*')
  );
}

/**
 * @param {SearchControllerOptions} options
 */
export function createSearchController(options) {
  const { store, searchApi } = options;
  const debounceMs = Number.isFinite(options.debounceMs) ? Number(options.debounceMs) : 200;

  const location =
    options.location ?? (typeof globalThis.location !== 'undefined' ? globalThis.location : null);
  const eventTarget =
    options.eventTarget !== undefined
      ? options.eventTarget
      : typeof globalThis.window !== 'undefined'
        ? globalThis.window
        : null;

  const setTimeoutFn =
    options.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout));
  const clearTimeoutFn = options.clearTimeout ?? (id => globalThis.clearTimeout(id));

  const defaults = createInitialSearchState();
  const existing = store.getState().search;
  store.setState({
    search: {
      ...defaults,
      ...(existing ?? {}),
      filters: { ...defaults.filters, ...(existing?.filters ?? {}) },
    },
  });

  let destroyed = false;
  let timer = /** @type {unknown} */ (null);
  let requestId = 0;
  /** @type {AbortController | null} */
  let pendingAbort = null;
  /** @type {{ payload: SearchPayload, append: boolean } | null} */
  let lastRun = null;

  /** @returns {SearchSlice} */
  function readSearch() {
    return store.getState().search;
  }

  /** @param {Partial<SearchSlice>} patch */
  function updateSearch(patch) {
    store.setState({ search: { ...readSearch(), ...patch } });
  }

  function resetResults() {
    lastRun = null;
    updateSearch({
      results: [],
      total: 0,
      hasMore: false,
      status: 'idle',
      error: null,
      offset: 0,
    });
  }

  /**
   * Invalidate any in-flight response and cancel the pending debounce. Bumping
   * the request id happens here (not only at request start) so a response that
   * resolves between a keystroke and the next request cannot win.
   */
  function cancelPending() {
    requestId += 1;
    if (pendingAbort) {
      pendingAbort.abort();
      pendingAbort = null;
    }
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  /** @param {SearchSlice} search */
  function effectiveSemantic(search) {
    // RAG is enabled unless the server explicitly reports `rag_enabled: false`;
    // the shared domain helper owns the "opt-in AND available" policy.
    const ragEnabled = store.getState().status?.rag_enabled !== false;
    return semanticEnabled(search, ragEnabled);
  }

  /**
   * @param {SearchSlice} search
   * @param {number} offset
   * @returns {SearchPayload}
   */
  function buildPayload(search, offset) {
    const request = buildSearchRequest({
      q: search.query,
      space: search.filters.space,
      tag: search.filters.tag,
      tier: search.filters.tier,
      tiers: search.filters.tiers,
      confidence: search.filters.confidence,
      semantic: effectiveSemantic(search),
      limit: DEFAULT_LIMIT,
      offset,
    });

    return {
      ...request,
      semantic: request.semantic ? 'on' : 'off',
    };
  }

  /**
   * @param {SearchPayload} payload
   * @param {boolean} append
   */
  function execute(payload, append) {
    const id = ++requestId;
    const abort = new AbortController();
    pendingAbort = abort;
    lastRun = { payload, append };

    updateSearch(
      append
        ? { status: 'loading', error: null }
        : {
            results: [],
            total: 0,
            hasMore: false,
            status: 'loading',
            error: null,
            offset: payload.offset ?? 0,
          }
    );

    searchApi(payload, { signal: abort.signal })
      .then(response => {
        if (destroyed || id !== requestId) return;
        pendingAbort = null;

        const incoming = Array.isArray(response?.results) ? response.results : [];
        const current = readSearch();
        const results = append ? [...current.results, ...incoming] : incoming;
        const total = Number.isFinite(response?.total) ? Number(response.total) : results.length;

        updateSearch({
          results,
          total,
          hasMore: Boolean(response?.hasMore),
          status: 'success',
          error: null,
          offset: payload.offset ?? 0,
        });
      })
      .catch(error => {
        if (destroyed || id !== requestId) return;
        if (error?.name === 'AbortError') return;
        pendingAbort = null;

        const message =
          error instanceof Error && error.message ? error.message : 'The search could not complete';
        updateSearch({ status: 'error', error: `Search failed: ${message}` });
      });
  }

  /**
   * @param {{ offset?: number, append?: boolean }} [runOptions]
   */
  function runSearch(runOptions = {}) {
    const search = readSearch();
    if (!hasActiveSearch(search.query, search.filters)) {
      cancelPending();
      resetResults();
      return;
    }

    cancelPending();
    const offset = Number.isFinite(runOptions.offset) ? Number(runOptions.offset) : 0;
    execute(buildPayload(search, offset), Boolean(runOptions.append));
  }

  function scheduleSearch() {
    const search = readSearch();
    if (!hasActiveSearch(search.query, search.filters)) {
      resetResults();
      return;
    }

    timer = setTimeoutFn(() => {
      timer = null;
      runSearch();
    }, debounceMs);
  }

  /**
   * @param {string} query
   * @param {{ run?: boolean }} [options]
   */
  function setQuery(query, options = {}) {
    if (destroyed) return;
    cancelPending();
    updateSearch({ query: typeof query === 'string' ? query : '' });
    if (options.run === false) return;
    scheduleSearch();
  }

  /**
   * @param {keyof SearchFilters} name
   * @param {SearchFilters[keyof SearchFilters]} value
   * @param {{ run?: boolean }} [options]
   */
  function setFilter(name, value, options = {}) {
    if (destroyed) return;
    cancelPending();
    updateSearch({ filters: { ...readSearch().filters, [name]: value } });
    if (options.run === false) return;
    runSearch();
  }

  /**
   * Apply the shared filter state to the search slice. The app owns the URL, so
   * this never writes history. `run: false` keeps the slice in sync for a
   * list-only change without firing a hidden `/api/search` request.
   *
   * @param {{
   *   q?: string,
   *   tag?: string,
   *   tiers?: Tier[],
   *   confidence?: Confidence | '',
   *   semantic?: boolean,
   * }} filters
   * @param {{ run?: boolean, debounce?: boolean }} [options]
   */
  function applyFilters(filters = {}, options = {}) {
    if (destroyed) return;
    cancelPending();
    const current = readSearch().filters;
    updateSearch({
      query: typeof filters.q === 'string' ? filters.q : '',
      filters: {
        ...current,
        tag: typeof filters.tag === 'string' ? filters.tag.trim() : '',
        tiers: Array.isArray(filters.tiers)
          ? filters.tiers.filter(t => t === 1 || t === 2 || t === 3).sort((a, b) => a - b)
          : [],
        tier: null,
        confidence:
          filters.confidence === 'high' ||
          filters.confidence === 'medium' ||
          filters.confidence === 'low'
            ? filters.confidence
            : null,
      },
      semantic: filters.semantic === true,
    });

    if (options.run === false) return;
    if (options.debounce) scheduleSearch();
    else runSearch();
  }

  /**
   * Scope the next search to a space, or `*` for global. This only updates the
   * filter: it never issues a request and never rewrites the URL on its own, so
   * callers can set the scope before a query exists. `setQuery` (or any other
   * search-triggering method) applies it to the request and the canonical URL.
   *
   * @param {string | null | undefined} space
   */
  function setScope(space) {
    if (destroyed) return;
    const next = typeof space === 'string' && space && space !== '*' ? space : '*';
    if (readSearch().filters.space === next) return;
    updateSearch({ filters: { ...readSearch().filters, space: next } });
  }

  /**
   * @param {boolean} enabled
   * @param {{ run?: boolean }} [options]
   */
  function setSemantic(enabled, options = {}) {
    if (destroyed) return;
    cancelPending();
    updateSearch({ semantic: Boolean(enabled) });
    if (options.run === false) return;
    runSearch();
  }

  /** @param {{ run?: boolean }} [options] */
  function clearQuery(options = {}) {
    if (destroyed) return;
    cancelPending();
    updateSearch({ query: '' });
    if (options.run === false) return;
    runSearch();
  }

  function clearAll() {
    if (destroyed) return;
    cancelPending();
    updateSearch({
      query: '',
      filters: { ...createInitialSearchState().filters },
      semantic: false,
    });
    resetResults();
  }

  function loadMore() {
    if (destroyed) return;
    const search = readSearch();
    if (search.status === 'loading' || !search.hasMore) return;
    runSearch({ offset: search.results.length, append: true });
  }

  function retry() {
    if (destroyed) return;
    if (lastRun) {
      cancelPending();
      execute(lastRun.payload, lastRun.append);
      return;
    }
    runSearch();
  }

  function restoreFromUrl() {
    if (destroyed) return;

    if (!location) {
      runSearch();
      return;
    }

    const route = parseAppRoute(location.pathname, location.search);
    const space = route.spaceName ? route.spaceName : route.spaceFilter || '*';

    cancelPending();
    updateSearch({
      query: route.q ?? '',
      filters: {
        space,
        tag: route.tag ?? '',
        tier: route.tier ?? null,
        tiers: Array.isArray(route.tiers) ? route.tiers : [],
        confidence: route.confidence ?? null,
      },
      semantic: Boolean(route.semantic),
    });
    runSearch();
  }

  function onPopState() {
    restoreFromUrl();
  }

  eventTarget?.addEventListener?.('popstate', onPopState);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelPending();
    eventTarget?.removeEventListener?.('popstate', onPopState);
  }

  return {
    setQuery,
    setFilter,
    applyFilters,
    setScope,
    setSemantic,
    clearQuery,
    clearAll,
    loadMore,
    retry,
    restoreFromUrl,
    cancelPending,
    destroy,
  };
}
