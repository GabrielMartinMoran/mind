// @ts-nocheck TODO(00019 Task 8): remove once the legacy app.js is split into typed modules.
import { getSpaceGraph } from './api/graph.js';
import { request } from './api/http.js';
import { clearLogs, listLogs } from './api/logs.js';
import {
  createMemory,
  deleteMemory,
  getMemory,
  queryMemoryPage,
  updateMemory,
} from './api/memories.js';
import { searchMemories } from './api/search.js';
import { createSpace, deleteSpace, getSpace, listSpaces, updateSpace } from './api/spaces.js';
import { listSpaceMemoryTags } from './api/tags.js';
import { createLogsPage } from './app/logs-page.js';
import { setupMemoryKeyboard } from './app/memory-keyboard.js';
import { createSearchController } from './app/search-controller.js';
import { setupSearchKeyboard } from './app/search-keyboard.js';
import { createSearchPage } from './app/search-page.js';
import { buildResultUrl, resolveSearchView } from './app/search-route.js';
import { createStore } from './app/store.js';
import {
  ALL_TIERS,
  clearFilters,
  hasActiveFilters,
  normalizeTiers,
  toListQuery,
} from './domain/filter-model.js';
import { capLogRows, filterParams, normalizeLogs, shouldPoll } from './domain/logs-model.js';
import { presentMemoryDetail, presentMemorySummary, presentSpace } from './domain/presenters.js';
import { filterVisibleSpaces } from './domain/space-filter.js';
import { buildTagOptions } from './domain/tag-options.js';
import { buildAppUrl, parseAppRoute } from './features/routing/routing.js';
import { renderFormErrors, validateMemoryForm, validateSpaceForm } from './views/forms.js';
import { applyGraphSelection, createGraphView } from './views/graph-view.js';
import { createIcon } from './views/icon.js';
import { renderMemoryList } from './views/memory-list.js';
import { createMemoryPanel } from './views/memory-panel.js';
import { createModal } from './views/modal.js';
import { setupShell, setupSpaNavigation, setupViewToggle } from './views/shell.js';
import { bindSpaceLinks, renderHomeSpaces, renderSpaceList } from './views/space-list.js';

/** @typedef {{ id:string, name:string, tier:1|2|3, pinned:boolean, access_count:number, tags?:string[] }} MemorySummary */
/** @typedef {{ id:string, space_name:string, name:string, content:string, tier:1|2|3, pinned:boolean, tags?:string[] }} Memory */
/** @typedef {{ name:string, description?:string, tags?:string[], memory_count?:number, tier_counts?:{t1:number,t2:number,t3:number}, hidden?:boolean }} Space */
/** @typedef {{ logs: any[], total: number, limit: number, offset: number }} LogsResult */
/** @typedef {{ scale: number, tx: number, ty: number }} GraphTransform */

/**
 * Graph slice: the fetched node/meta payload plus selection and transform.
 * Tier and only-matches controls live in the shared filter state.
 *
 * @returns {{
 *   nodes: any[],
 *   edges: any[] | null,
 *   meta: any,
 *   selectedId: string | number | null,
 *   status: 'idle' | 'loading' | 'success' | 'error',
 *   error: string | null,
 *   limit: number,
 *   transform: GraphTransform,
 * }}
 */
function createInitialGraphState() {
  return {
    nodes: [],
    edges: null,
    meta: null,
    selectedId: null,
    status: 'idle',
    error: null,
    limit: 1000,
    transform: { scale: 1, tx: 0, ty: 0 },
  };
}

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  /** @type {Space[]} */
  spaces: [],
  /** @type {Space | null} */
  currentSpace: null,
  /** @type {MemorySummary[]} */
  memories: [], // MemorySummary[]
  // ── Paginated memory list slice ───────────────────────────────────────────
  memoryTotal: 0,
  memoryHasMore: false,
  memoryOffset: 0,
  /** Shared in-space filter state, owned here and serialized by `syncUrl`. */
  /** @type {import('./domain/filter-model.js').FilterState} */
  filters: clearFilters(),
  /** Memory tags of the current space, used to populate the shared Tag select. */
  /** @type {string[]} */
  tagOptions: [],
  /** @type {'idle'|'loading'|'success'|'error'} */
  memoryStatus: 'idle',
  /** @type {string|null} */
  memoryError: null,
  // Which space + filter pair the current list slice belongs to. A search route
  // can leave the list untouched (`loadMemories: false`), so returning to the
  // space detail must know whether the visible list is still valid.
  /** @type {string|null} */
  memoryListSpace: null,
  /** @type {string} */
  memoryListKey: '',
  /** @type {Memory | null} */
  currentMemory: null, // Memory (full)
  showHiddenSpaces: false,
  /** In-memory All spaces query. Survives opening a space and returning. */
  homeQuery: '',
  spaceView: 'list',
  /** @type {any} */
  status: null,
  /** Global (all-spaces) status, kept separate from the per-space status panel. */
  /** @type {any} */
  globalStatus: null,
  graph: createInitialGraphState(),
  // Logs route flag + owned state slice
  logsActive: false,
  logs: createInitialLogsState(),
};

/**
 * Initial logs slice. Filters, pagination and live mode live here; the view
 * renders it and reports intent back through handlers.
 *
 * @returns {any}
 */
function createInitialLogsState() {
  return {
    logs: [],
    total: 0,
    limit: 25,
    offset: 0,
    dropped: 0,
    filters: { source: '', operation: '', level: '', search: '', from: '', to: '' },
    live: false,
    status: 'idle',
    error: null,
    expandedId: null,
    visible: true,
    lastUpdatedAt: '',
  };
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const elSpaceList = $('space-list');
const elAllSpacesLink = $('all-spaces-link');
const elEmptyState = $('empty-state');
const elHomeSearchForm = $('home-search-form');
const elHomeSearch = /** @type {HTMLInputElement | null} */ ($('home-search'));
const elBtnClearHomeSearch = $('btn-clear-home-search');
const elHomeSearchStatus = $('home-search-status');
const elHomeSpaces = $('home-spaces');
const elHomeNoResults = $('home-no-results');
const elHomeEmpty = $('home-empty');
const elSpaceDetail = $('space-detail');
const elSpaceSearchView = $('space-search-view');
const elMemoryPanel = $('memory-panel');
const elSpaceSearchForm = $('space-search-form');
const elSpaceSearch = $('space-search');
const elSpaceSearchLabel = $('space-search-label');
const elBtnClearSpaceSearch = $('btn-clear-space-search');
const elFilterTag = $('space-filter-tag');
const elClearFilters = $('space-clear-filters');
const elTierChips = [1, 2, 3].map(tier => $(`space-tier-${tier}`));
const elFilterConfidence = $('space-filter-confidence');
const elFilterSemantic = $('space-filter-semantic');
const elFilterSemanticHelp = $('space-filter-semantic-help');
const elFilterOnlyMatches = $('space-filter-only-matches');
const elConfidenceField = $('space-filter-confidence-field');
const elSemanticField = $('space-filter-semantic-field');
const elOnlyMatchesField = $('space-filter-only-matches-field');
const elSpaceTitle = $('space-title');
const elSpaceDesc = $('space-desc');
const elSpaceTagsRow = $('space-tags-row');
const elStatusSpaces = $('status-spaces');
const elStatusTiers = $('status-tiers');
const elSpaceCount = $('space-count');
const elListView = $('list-view');
const elGraphView = $('graph-view');
const elToggleHiddenSpaces = $('toggle-hidden-spaces');
// Logs DOM refs. The view owns the filters, table and pagination; the shell
// only provides the page container, the single heading and the clear action.
const elLogsPage = $('logs-page');
const elLogsView = $('logs-view');
const elBtnClearLogs = $('btn-clear-logs');

// ── Search store, controller and page ─────────────────────────────────────────
/**
 * Initial search slice. `currentSpace` describes the route; the controller
 * owns query, filters and results and keeps it untouched.
 *
 * @returns {any}
 */
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
    currentSpace: null,
  };
}

const searchStore = createStore({
  status: null,
  search: createInitialSearchState(),
});

const searchController = createSearchController({
  store: searchStore,
  searchApi: searchMemories,
});

/** @type {ReturnType<typeof createSearchPage> | null} */
let searchPage = null;
/** @type {string | null} */
let searchViewMode = null;

function createSearchPageInstance() {
  return createSearchPage({
    root: elSpaceSearchView,
    store: searchStore,
    controller: searchController,
    getStatus: () => state.status,
    onOpenResult: openSearchResult,
  });
}

/**
 * Mount (or refresh) the search page for the open space.
 *
 * Search is always scoped to the current space now, so the composed page is
 * built once per space. Switching spaces rebuilds the fixed "space" chip while
 * query, filters and results stay in the controller/store.
 *
 * @param {{ name: string }} currentSpace
 */
function ensureSearchPage(currentSpace) {
  const search = searchStore.getState().search;
  searchStore.setState({
    search: { ...search, currentSpace: currentSpace ?? null },
  });

  const key = `space:${currentSpace?.name ?? ''}`;
  if (searchPage && searchViewMode === key) {
    searchPage.update();
    return;
  }

  searchViewMode = key;
  if (searchPage) searchPage.destroy();
  searchPage = createSearchPageInstance();
  searchPage.mount();
}

/**
 * Open a search result without losing the search: the memory selection pushes
 * its own history entry, then the URL is replaced with the canonical result URL
 * carrying the active query and filters, so Back returns to the search.
 *
 * @param {{ space_name: string, name: string }} result
 */
async function openSearchResult(result) {
  if (state.currentSpace?.name !== result.space_name) {
    await selectSpace(result.space_name, { updateUrl: false });
  }

  showPanel('space');
  await selectMemory(result.space_name, result.name);

  const url = buildResultUrl(result, searchStore.getState().search);
  window.history.replaceState({}, '', url);
}

// ── Tier helpers ──────────────────────────────────────────────────────────────
const TIER_LABEL = { 1: 'T1 — Hot', 2: 'T2 — Warm', 3: 'T3 — Cold' };
const TIER_CLASS = { 1: 't1', 2: 't2', 3: 't3' };
const TIER_LIMITS = { 1: 25, 2: 50, 3: null }; // null = unlimited
const MEMORY_PAGE_SIZE = 100;
/** One request returns every node the backend can serve (its current max is 1,000). */
const GRAPH_FETCH_LIMIT = 1000;
const LOGS_POLL_INTERVAL_MS = 5000;

// ── Status panel ──────────────────────────────────────────────────────────────

/**
 * Show the total space count in the rail heading. The heading text becomes
 * "Spaces 87", which stays readable for assistive technology without a
 * separate decorative badge label.
 *
 * @param {number | null | undefined} total
 */
function renderSpaceCount(total) {
  if (!elSpaceCount) return;
  elSpaceCount.textContent =
    typeof total === 'number' && Number.isFinite(total) ? String(total) : '';
}

function appendStatusTierPill(tier, value) {
  const cls = TIER_CLASS[tier] ?? '';
  const limit = TIER_LIMITS[tier];
  const cap = typeof value === 'number' && limit != null ? `/${limit}` : '';
  const pill = document.createElement('span');
  pill.className = `status-tier-pill ${cls}`;
  pill.title = TIER_LABEL[tier] ?? `T${tier}`;
  pill.setAttribute('aria-label', `${TIER_LABEL[tier] ?? `Tier ${tier}`}: ${value}${cap}`);

  // Tier pills are state marks, not commands: they stay icon-free.
  const label = document.createElement('span');
  label.className = 'status-tier-label';
  label.textContent = `T${tier}`;
  const valueNode = document.createElement('span');
  valueNode.className = 'status-tier-value';
  valueNode.textContent = `${value}${cap}`;

  pill.append(label, valueNode);
  elStatusTiers.appendChild(pill);
}

function renderStatusPlaceholder() {
  state.status = null;
  elStatusSpaces.textContent = '-';
  renderSpaceCount(
    state.globalStatus?.total_spaces ?? (state.spaces.length > 0 ? state.spaces.length : null)
  );
  elStatusTiers.innerHTML = '';
  for (const tier of [1, 2, 3]) {
    appendStatusTierPill(tier, '-');
  }
}

function renderStatus(status) {
  const spaces = status.total_spaces ?? 0;
  const memories = status.total_memories ?? 0;
  elStatusSpaces.textContent = `${spaces} ${spaces === 1 ? 'space' : 'spaces'} · ${memories} ${memories === 1 ? 'memory' : 'memories'}`;
  renderSpaceCount(state.globalStatus?.total_spaces ?? state.spaces.length);
  elStatusTiers.innerHTML = '';
  for (const t of status.by_tier ?? []) {
    appendStatusTierPill(t.tier, t.count);
  }
}

async function loadStatus(spaceName = state.currentSpace?.name) {
  try {
    const status = await request(spaceName ? `/api/status?space=${enc(spaceName)}` : '/api/status');
    state.status = status;
    // The sidebar badge is global. A per-space status response reports only that
    // space, so keep the last authoritative all-spaces total for the rail.
    if (!spaceName) state.globalStatus = status;
    searchStore.setState({ status });
    renderStatus(status);
  } catch {
    renderStatusPlaceholder();
    searchStore.setState({ status: null });
  }

  // The embeddings toggle reflects `rag_enabled` once status loads.
  searchPage?.update();

  if (!state.currentSpace) {
    renderHomeView();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Mark "All spaces" as the current page only on the home route. It stays a
 * plain navigation entry, not a synthetic space, so opening a space or logs
 * clears the current state.
 */
function syncAllSpacesNav() {
  const isHome = !state.currentSpace && !state.logsActive;
  elAllSpacesLink?.classList.toggle('is-active', isHome);
  if (isHome) {
    elAllSpacesLink?.setAttribute('aria-current', 'page');
  } else {
    elAllSpacesLink?.removeAttribute('aria-current');
  }
}

function renderSidebar() {
  renderSpaceCount(state.globalStatus?.total_spaces ?? state.spaces.length);
  syncAllSpacesNav();
  const items = renderSpaceList(state.spaces, {
    currentSpace: state.currentSpace,
    includeHidden: state.showHiddenSpaces,
  });
  elSpaceList.replaceChildren(...items);
}

/**
 * Render the home overview without rebuilding its stable shell. Only the space
 * rows, the result count, the no-results note and the empty states are patched,
 * so the search input keeps its focus, value and caret across refreshes.
 */
function renderHomeView() {
  if (!elHomeSpaces || !elHomeEmpty) return;

  const query = state.homeQuery.trim();
  const allVisible = state.spaces.filter(space => !space.hidden);
  const matching = filterVisibleSpaces(state.spaces, state.homeQuery);
  const isTrueEmpty = allVisible.length === 0;

  // Never write into the focused input: it is the source of truth while typing.
  if (
    elHomeSearch &&
    document.activeElement !== elHomeSearch &&
    elHomeSearch.value !== state.homeQuery
  ) {
    elHomeSearch.value = state.homeQuery;
  }

  elHomeSpaces.replaceChildren(...renderHomeSpaces(matching, { currentSpace: state.currentSpace }));
  elHomeSpaces.hidden = matching.length === 0;

  const showNoResults = !isTrueEmpty && matching.length === 0 && query.length > 0;
  if (elHomeNoResults) {
    elHomeNoResults.hidden = !showNoResults;
    if (showNoResults) {
      elHomeNoResults.textContent = `No spaces match ‘${query}’. Try fewer words or a different term.`;
    }
  }

  elHomeEmpty.hidden = !isTrueEmpty;

  const showCount = query.length > 0 && !isTrueEmpty;
  if (elHomeSearchStatus) {
    elHomeSearchStatus.hidden = !showCount;
    elHomeSearchStatus.textContent = showCount
      ? `Showing ${matching.length} of ${allVisible.length} ${
          allVisible.length === 1 ? 'space' : 'spaces'
        }`
      : '';
  }

  if (elBtnClearHomeSearch) {
    elBtnClearHomeSearch.hidden = query.length === 0;
  }
}

function renderSpaceDetail() {
  const sp = state.currentSpace;
  if (!sp) return;

  hideSpaceTagInput({ restoreFocus: false });

  elSpaceTitle.textContent = sp.name;
  elSpaceDesc.textContent = sp.description || 'No description';

  if (elSpaceSearch) {
    elSpaceSearch.placeholder = `Search memories in ${sp.name}`;
  }
  if (elSpaceSearchLabel) {
    elSpaceSearchLabel.textContent = `Search in ${sp.name}`;
  }

  // Tags
  renderTagRow(
    elSpaceTagsRow,
    sp.tags ?? [],
    (tag, trigger) => {
      openDeleteConfirmation({
        title: 'Remove tag',
        message: `Remove tag #${tag} from "${sp.name}"?`,
        confirmLabel: 'Remove tag',
        trigger,
        onConfirm: async () => {
          try {
            await updateSpace(sp.name, { removeTag: tag });
          } catch (err) {
            throw new Error(`Failed to remove tag: ${err.message || 'Unknown error'}`);
          }
          await refreshSpace(sp.name);
        },
      });
    },
    trigger => showSpaceTagInput(sp.name, trigger)
  );

  // Memory list (filters, cards, pagination and async states)
  renderMemoryListView();

  renderGraphPanel();
  setSpaceView(state.spaceView, { updateUrl: false });
}

function setSpaceView(view, options = {}) {
  const { updateUrl = true } = options;
  state.spaceView = view === 'map' ? 'map' : 'list';
  const showMap = state.spaceView === 'map';

  elGraphView?.classList.toggle('hidden', !showMap);
  updateSpaceSearchVisibility();

  // The shell owns aria-pressed, is-active and the roving tabindex. This keeps
  // the toggle state in one place and never moves focus during re-renders.
  viewToggle.setView(state.spaceView);

  if (updateUrl && state.currentSpace) {
    syncUrl();
  }
}

/**
 * Normalize a partial filter state (route or UI intent) into the shared shape.
 * An empty tier selection means "all tiers" and is stored explicitly.
 *
 * @param {Partial<import('./domain/filter-model.js').FilterState>} [filters]
 * @returns {import('./domain/filter-model.js').FilterState}
 */
function normalizeFilterState(filters = {}) {
  const base = clearFilters();
  const tiers = normalizeTiers(filters.tiers);
  const confidence =
    filters.confidence === 'high' || filters.confidence === 'medium' || filters.confidence === 'low'
      ? filters.confidence
      : '';
  return {
    q: typeof filters.q === 'string' ? filters.q : base.q,
    tag: typeof filters.tag === 'string' ? filters.tag.trim() : base.tag,
    tiers: tiers.length === 0 ? [...ALL_TIERS] : tiers,
    confidence,
    semantic: filters.semantic === true,
    onlyMatches: filters.onlyMatches === true,
  };
}

/**
 * Stable identity for the list filters. It decides whether the rendered list
 * still matches the space detail the user is looking at; query and confidence
 * are search-only and never affect the list request.
 *
 * @param {import('./domain/filter-model.js').FilterState} [filters]
 * @returns {string}
 */
function listFiltersSignature(filters = state.filters) {
  return `${normalizeTiers(filters.tiers).join(',')}|${filters.tag ?? ''}`;
}

/**
 * Fetch one page from the paginated query endpoint and present the summaries.
 *
 * @param {string} spaceName
 * @param {import('./domain/filter-model.js').FilterState} filters
 * @param {number} offset
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ items: MemorySummary[], total: number }>}
 */
async function fetchMemoryPage(spaceName, filters, offset, signal) {
  const listQuery = toListQuery(filters);
  const page = await queryMemoryPage(
    {
      space: spaceName,
      ...listQuery,
      limit: MEMORY_PAGE_SIZE,
      offset,
    },
    { signal }
  );
  return {
    items: page.items.map(presentMemorySummary),
    total: page.total,
  };
}

/**
 * Retained memory-list mount. The `#memory-status` live region is built once
 * and patched in place so a filter change never destroys it. The shared filter
 * bar lives in the static shell header; only the dynamic results (tier
 * sections, skeleton, empty/error states, pagination) are replaced.
 *
 * @type {{ root: HTMLElement, region: HTMLElement, status: HTMLElement } | null}
 */
let memoryListMount = null;

/** Render the composed memory list into its shell container. */
function renderMemoryListView() {
  if (!elListView) return;

  const view = renderMemoryList(
    {
      space: state.currentSpace?.name ?? '',
      memories: state.memories,
      total: state.memoryTotal,
      hasMore: state.memoryHasMore,
      offset: state.memoryOffset,
      filters: state.filters,
      status: state.memoryStatus,
      error: state.memoryError,
      currentMemory: state.currentMemory,
    },
    {
      onLoadMore: handleMemoryLoadMore,
      onRetry: handleMemoryRetry,
      onCreate: () => $('btn-add-memory')?.click(),
      onOpen: handleMemoryOpen,
    }
  );

  const mount = memoryListMount;
  const nextRegion = view.querySelector('.memory-list-region');
  const nextStatus = view.querySelector('.memory-status');

  // First render (or a container swap) mounts the whole structure once.
  if (!mount || mount.root.parentNode !== elListView || !nextRegion || !nextStatus) {
    memoryListMount = {
      root: view,
      region: nextRegion,
      status: nextStatus,
    };
    elListView.replaceChildren(view);
    return;
  }

  // Keep the status live region stable; replace only the dynamic results.
  mount.root.setAttribute('aria-busy', view.getAttribute('aria-busy') ?? 'false');
  mount.status.textContent = nextStatus.textContent;
  mount.status.setAttribute('aria-busy', nextStatus.getAttribute('aria-busy') ?? 'false');

  for (const child of Array.from(mount.region.children)) {
    if (child !== mount.status) child.remove();
  }
  for (const child of Array.from(nextRegion.children)) {
    if (child === nextStatus) continue;
    mount.region.appendChild(child);
  }
}

/**
 * Monotonic request id and in-flight controller for the memory page. Rapid
 * filter changes must not let a slower earlier response overwrite a newer one:
 * every load bumps the id, aborts the previous fetch, and discards its result.
 */
let memoryRequestId = 0;
/** @type {AbortController | null} */
let memoryRequestController = null;

/**
 * Load a page of memories for the active space and filters.
 *
 * `reset` replaces the accumulated list (first page or filter change); without
 * it the next page is appended. Errors stay inside the list slice so a failed
 * page shows the retry state instead of dropping the user back home.
 *
 * @param {{ reset?: boolean, space?: string }} [options]
 * @returns {Promise<number>} Number of items added by this request.
 */
async function loadMemoryPage(options = {}) {
  const { reset = false, space = state.currentSpace?.name } = options;
  if (!space) return 0;

  const requestId = ++memoryRequestId;
  memoryRequestController?.abort();
  const controller = new AbortController();
  memoryRequestController = controller;

  if (reset) {
    state.memories = [];
    state.memoryTotal = 0;
    state.memoryOffset = 0;
    state.memoryHasMore = false;
  }

  const offset = reset ? 0 : state.memoryOffset;
  const previousCount = reset ? 0 : state.memories.length;

  // Own the list slice for the space + filters this request is for. A request
  // for an older filter/space must never be mistaken for the current list.
  state.memoryListSpace = space;
  state.memoryListKey = listFiltersSignature();

  state.memoryStatus = 'loading';
  state.memoryError = null;
  renderMemoryListView();

  try {
    const page = await fetchMemoryPage(space, state.filters, offset, controller.signal);
    if (requestId !== memoryRequestId) return 0;
    state.memories = reset ? page.items : [...state.memories, ...page.items];
    state.memoryTotal = page.total;
    state.memoryOffset = previousCount + page.items.length;
    state.memoryHasMore = state.memoryOffset < page.total;
    state.memoryStatus = 'success';
    state.memoryError = null;
    renderMemoryListView();
    return page.items.length;
  } catch (err) {
    if (requestId !== memoryRequestId || controller.signal.aborted) return 0;
    state.memoryStatus = 'error';
    state.memoryError = err?.message || 'The memories could not be loaded. Try again.';
    renderMemoryListView();
    return 0;
  } finally {
    if (memoryRequestController === controller) memoryRequestController = null;
  }
}

/**
 * Guarantee the visible space detail has a list for the current space/filters.
 *
 * A space search boots with `loadMemories: false`, so the list slice may be
 * idle, stale for another space, or a loading placeholder with no request
 * behind it. The search surface itself does not need the list; the in-app paths
 * that reveal the space detail (dismiss search, close a result panel) call this
 * to fetch page 1 exactly once. An already-loaded matching list, or a matching
 * request that is still in flight, is left alone.
 */
function ensureMemoryListLoaded() {
  const spaceName = state.currentSpace?.name;
  if (!spaceName) return;

  const matches =
    state.memoryListSpace === spaceName && state.memoryListKey === listFiltersSignature();
  if (matches && state.memoryStatus === 'success') return;
  // `memoryRequestController` is only non-null while a request is in flight, so
  // a stray loading placeholder without a request still recovers here.
  if (matches && state.memoryStatus === 'loading' && memoryRequestController !== null) return;

  void loadMemoryPage({ reset: true, space: spaceName });
}

/** @param {string} name */
function findMemoryCard(name) {
  const cards = Array.from(elListView?.querySelectorAll('.memory-card') ?? []);
  return /** @type {HTMLElement | undefined} */ (
    cards.find(card => /** @type {HTMLElement} */ (card).dataset.memoryName === name)
  );
}

/** @param {string} name */
function focusMemoryCardLink(name) {
  findMemoryCard(name)?.querySelector('a.memory-card-link')?.focus();
}

/**
 * Reflect a panel mutation in the backing list slice. The visible card is
 * rebuilt from state so tier, pin and tag changes stay consistent with the list.
 * When the memory is not part of the current slice (search or deep-link opens),
 * the list is left untouched and only the panel reflects the change.
 *
 * @param {string} name
 * @param {Record<string, any>} changes
 */
function updateMemoryCard(name, changes) {
  const index = state.memories.findIndex(item => item.name === name);
  if (index === -1) return;
  state.memories[index] = { ...state.memories[index], ...changes };
  renderMemoryListView();
}

async function handleMemoryLoadMore() {
  if (state.memoryStatus === 'loading') return;
  const previousCount = state.memories.length;
  await loadMemoryPage({ reset: false });
  const firstNew = state.memories[previousCount];
  if (firstNew) focusMemoryCardLink(firstNew.name);
}

function handleMemoryRetry() {
  // Reload the page that failed: the first page when the list is empty, the
  // next page when a "Show more" request failed.
  loadMemoryPage({ reset: state.memories.length === 0 });
}

/**
 * Open a memory through the existing panel path.
 *
 * @param {MemorySummary & { space_name?: string }} memory
 */
function handleMemoryOpen(memory) {
  const spaceName = memory.space_name ?? state.currentSpace?.name;
  if (!spaceName) return;
  selectMemory(spaceName, memory.name, { trigger: findMemoryTrigger(memory.name) });
}

// ── Neural map ────────────────────────────────────────────────────────────────
/**
 * Monotonic request id + abort controller for the graph fetch. A new space must
 * never be overwritten by a slower earlier response.
 */
let graphRequestId = 0;
/** @type {AbortController | null} */
let graphRequestController = null;
/** @type {string} */
let lastGraphSearchSignature = '';
/** @type {ReturnType<typeof createGraphView> | null} */
let graphMount = null;

/**
 * Read the active search slice as graph highlight input. Only results in the
 * current space can match a node; results for other spaces are ignored, while
 * in-space results missing from a truncated graph surface as outside matches.
 *
 * @returns {{ active: boolean, ids: Array<string | number> }}
 */
function readGraphSearch() {
  const search = searchStore.getState().search;
  const spaceName = state.currentSpace?.name ?? '';
  // Only a query turns the map into a highlight/dim surface. Tier and tag are
  // structural filters, and confidence is hidden on the map.
  const hasCriteria = Boolean(search.query.trim());
  const results = Array.isArray(search.results) ? search.results : [];
  const ids = results
    .filter(result => !result?.space_name || result.space_name === spaceName)
    .map(result => result?.id)
    .filter(id => id !== undefined && id !== null);

  return { active: hasCriteria && search.status === 'success', ids };
}

/** Stable signature so unrelated store updates never rebuild the map. */
function graphSearchSignature() {
  const { active, ids } = readGraphSearch();
  return `${active ? 1 : 0}|${ids.map(id => String(id)).join(',')}`;
}

/**
 * Fetch the graph for a space and merge the payload into the graph slice. The
 * error stays inside the map so a failed graph never drops the space detail.
 *
 * @param {string} spaceName
 */
async function loadGraph(spaceName) {
  if (!spaceName) return;
  const limit = GRAPH_FETCH_LIMIT;

  const requestId = ++graphRequestId;
  graphRequestController?.abort();
  const controller = new AbortController();
  graphRequestController = controller;

  state.graph = {
    ...createInitialGraphState(),
    ...state.graph,
    status: 'loading',
    error: null,
    limit,
  };
  renderGraphPanel();

  try {
    const graph = await getSpaceGraph(spaceName, { limit }, { signal: controller.signal });
    if (requestId !== graphRequestId || controller.signal.aborted) return;

    state.graph = {
      ...state.graph,
      nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph?.edges) ? graph.edges : null,
      meta: graph?.meta ?? null,
      status: 'success',
      error: null,
      limit,
    };
    if (state.currentSpace?.name === spaceName) renderGraphPanel();
  } catch (err) {
    if (requestId !== graphRequestId || controller.signal.aborted) return;
    state.graph = {
      ...state.graph,
      status: 'error',
      error: err?.message || 'The graph could not be loaded. Try again.',
    };
    if (state.currentSpace?.name === spaceName) renderGraphPanel();
  } finally {
    if (graphRequestController === controller) graphRequestController = null;
  }
}

/** Render the graph container from the current graph slice. */
function renderGraphPanel() {
  if (!elGraphView) return;

  if (!state.currentSpace) {
    graphMount?.destroy();
    graphMount = null;
    elGraphView.replaceChildren();
    return;
  }

  const graph = state.graph;
  const search = readGraphSearch();

  if (!graphMount) {
    graphMount = createGraphView(elGraphView, {
      onRetry: handleGraphRetry,
      onOpenNode: handleGraphOpenNode,
      onSelectNode: handleGraphSelectNode,
      onTransformChange: handleGraphTransformChange,
    });
  }

  graphMount.update({
    space: state.currentSpace,
    nodes: graph.nodes,
    edges: graph.edges,
    meta: graph.meta,
    searchActive: search.active,
    searchIds: search.ids,
    tierFilters: state.filters.tiers,
    onlyMatches: state.filters.onlyMatches,
    selectedId: graph.selectedId,
    status: graph.status,
    error: graph.error,
    transform: graph.transform,
  });
}

function handleGraphRetry() {
  const spaceName = state.currentSpace?.name;
  if (!spaceName) return;
  void loadGraph(spaceName);
}

/** @param {{ id: string | number, name: string }} node */
function handleGraphSelectNode(node) {
  state.graph = { ...state.graph, selectedId: node.id };
  applyGraphSelection(elGraphView, node.id);
}

/** @param {{ id: string | number, name: string }} node */
function handleGraphOpenNode(node) {
  const spaceName = state.currentSpace?.name;
  if (!spaceName) return;
  state.graph = { ...state.graph, selectedId: node.id };
  applyGraphSelection(elGraphView, node.id);

  const trigger = Array.from(elGraphView?.querySelectorAll('g.graph-node') ?? []).find(
    element => element.getAttribute('data-node-id') === String(node.id)
  );
  selectMemory(spaceName, node.name, { trigger: trigger ?? null });
}

/** @param {GraphTransform} transform */
function handleGraphTransformChange(transform) {
  state.graph = { ...state.graph, transform };
}

/**
 * Keep the graph highlight in sync with the search store. This only re-renders
 * when the match set actually changes, and never refetches, so typing a query
 * cannot trigger a request loop or reset the graph payload.
 */
searchStore.subscribe(() => {
  if (!state.currentSpace || state.graph.status !== 'success') return;
  const signature = graphSearchSignature();
  if (signature === lastGraphSearchSignature) return;
  lastGraphSearchSignature = signature;
  renderGraphPanel();
});

/**
 * Render a tag row: each tag is a removable chip and a trailing `+ tag` button.
 * The confirm dialog and the inline add input are owned by `renderSpaceDetail`;
 * the row only reports which control was activated.
 *
 * @param {HTMLElement} container
 * @param {string[]} tags
 * @param {(tag: string, trigger: HTMLElement) => void} onRemove
 * @param {(trigger: HTMLElement) => void} onAdd
 */
function renderTagRow(container, tags, onRemove, onAdd) {
  container.textContent = '';
  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag';
    chip.textContent = '#' + tag;
    chip.title = 'Remove tag';
    chip.setAttribute('aria-label', `Remove tag ${tag}`);
    chip.appendChild(createIcon('x', { document, size: 'sm' }));
    chip.addEventListener('click', event => {
      event.stopPropagation();
      onRemove(tag, chip);
    });
    container.appendChild(chip);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tag-add';
  addBtn.textContent = '+ tag';
  addBtn.setAttribute('aria-label', 'Add tag');
  addBtn.prepend(createIcon('tag', { document, size: 'sm' }));
  addBtn.addEventListener('click', () => onAdd(addBtn));
  container.appendChild(addBtn);
}

/** @type {{ spaceName: string, trigger: HTMLElement | null } | null} */
let pendingSpaceTag = null;

/**
 * Reveal the inline space-tag input for `spaceName` and focus it.
 *
 * @param {string} spaceName
 * @param {HTMLElement | null} trigger
 */
function showSpaceTagInput(spaceName, trigger) {
  const row = $('space-tag-input-row');
  const input = $('space-tag-input');
  if (!row || !input) return;
  pendingSpaceTag = { spaceName, trigger };
  row.classList.remove('hidden');
  input.value = '';
  input.focus();
}

/**
 * Hide the inline space-tag input. Focus returns to the `+ tag` trigger by
 * default so a cancelled entry never strands the keyboard user.
 *
 * @param {{ restoreFocus?: boolean }} [options]
 */
function hideSpaceTagInput(options = {}) {
  const { restoreFocus = true } = options;
  const row = $('space-tag-input-row');
  const input = $('space-tag-input');
  const trigger = pendingSpaceTag?.trigger ?? null;
  pendingSpaceTag = null;

  if (row) row.classList.add('hidden');
  if (input) input.value = '';
  if (!restoreFocus) return;
  if (trigger && trigger.isConnected !== false) trigger.focus();
}

/** Commit the inline space-tag input through the PATCH endpoint. */
async function submitSpaceTagInput() {
  const pending = pendingSpaceTag;
  const input = $('space-tag-input');
  const value = input ? input.value.trim().toLowerCase() : '';
  hideSpaceTagInput();
  if (!pending || !value) return;

  try {
    await updateSpace(pending.spaceName, { addTag: value });
    await refreshSpace(pending.spaceName);
  } catch (err) {
    showToast(`Failed to add tag: ${err.message || 'Unknown error'}`, 'error');
  }
}

$('space-tag-input')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitSpaceTagInput();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hideSpaceTagInput();
  }
});
$('btn-space-tag-confirm')?.addEventListener('click', submitSpaceTagInput);

// ── Panels ────────────────────────────────────────────────────────────────────
function showPanel(panelName) {
  // Leaving the logs route must stop its polling: every other view (home,
  // space) is a different surface with no live log stream.
  if (panelName !== 'logs' && state.logsActive) closeLogsPage();

  elEmptyState.classList.add('hidden');
  elSpaceDetail.classList.add('hidden');
  elLogsPage.classList.add('hidden');

  if (panelName === 'empty') elEmptyState.classList.remove('hidden');
  else if (panelName === 'space') elSpaceDetail.classList.remove('hidden');
  else if (panelName === 'logs') elLogsPage.classList.remove('hidden');
}

/** True while the in-space search results are the visible list surface. */
function isSearchSurfaceVisible() {
  return Boolean(elSpaceSearchView) && !elSpaceSearchView.classList.contains('hidden');
}

// ── Memory panel ──────────────────────────────────────────────────────────────
// The dialog controller (`createMemoryPanel`) is the single owner of panel
// open/close, focus return, Escape/backdrop and the loading/error/edit states.
// The app supplies the data, the URL and the list side effects via handlers.

/** Monotonic request id + abort controller for the memory detail fetch. */
let memoryDetailRequestId = 0;
/** @type {AbortController | null} */
let memoryDetailController = null;
/** @type {{ spaceName: string, memName: string, trigger: Element | null } | null} */
let pendingMemorySelection = null;

/**
 * Focus fallback used when a deep link opens the panel with no visible trigger.
 *
 * @returns {Element | null}
 */
function memoryPanelFallbackTrigger() {
  return $('btn-mem-close-inline') ?? $('btn-mem-close');
}

/**
 * Resolve the control that opened a memory so focus can return to it. Cards and
 * search result links are matched by name; a deep link with no visible control
 * falls back to the panel close button.
 *
 * @param {string} name
 * @returns {Element | null}
 */
function findMemoryTrigger(name) {
  const cardLink = findMemoryCard(name)?.querySelector('a.memory-card-link');
  if (cardLink) return cardLink;

  const results = Array.from(elSpaceSearchView?.querySelectorAll('a.search-result-link') ?? []);
  const resultLink = results.find(
    link => link.querySelector('.search-result-name')?.textContent === name
  );
  return resultLink ?? memoryPanelFallbackTrigger();
}

const panel = createMemoryPanel({
  dialog: elMemoryPanel,
  document,
  handlers: {
    onClose: closeMemoryPanel,
    onSave: handlePanelSave,
    onPin: handlePanelPin,
    onPromote: handlePanelPromote,
    onDemote: handlePanelDemote,
    onAddTagSubmit: handlePanelAddTagSubmit,
    onRemoveTag: handlePanelRemoveTag,
    onDelete: handlePanelDelete,
    onRetry: retryPendingMemory,
  },
});

/**
 * Close the panel and clear the selected memory. The controller clears the edit
 * state and restores focus; the URL drops `memory` while keeping q/filters/view.
 */
function closeMemoryPanel() {
  pendingMemorySelection = null;
  state.currentMemory = null;
  state.graph = { ...state.graph, selectedId: null };
  applyGraphSelection(elGraphView, null);

  panel.close();
  removeMemoryParamFromUrl();
  clearCurrentMemoryHighlight();

  // A result-opened panel can sit over a space detail whose list was never
  // loaded (space search routes skip the fetch). Re-fetch only when the space
  // detail is actually the visible surface.
  if (state.currentSpace && !isSearchSurfaceVisible()) ensureMemoryListLoaded();
}

/**
 * Remove only the `memory` param from the current URL so closing a panel never
 * loses the active query, filters or view.
 */
function removeMemoryParamFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('memory')) return;
  url.searchParams.delete('memory');
  const search = url.searchParams.toString();
  window.history.replaceState({}, '', `${url.pathname}${search ? `?${search}` : ''}`);
}

/**
 * Mark the open memory's card as current without rebuilding the list, so the
 * trigger node stays connected for focus return.
 *
 * @param {string} name
 */
function markCurrentMemory(name) {
  for (const card of Array.from(elListView?.querySelectorAll('.memory-card') ?? [])) {
    const isCurrent = /** @type {HTMLElement} */ (card).dataset.memoryName === name;
    card.classList.toggle('is-current', isCurrent);
    const link = card.querySelector('a.memory-card-link');
    if (!link) continue;
    if (isCurrent) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

/** Clear the current-memory highlight left by `markCurrentMemory`. */
function clearCurrentMemoryHighlight() {
  for (const card of Array.from(elListView?.querySelectorAll('.memory-card.is-current') ?? [])) {
    card.classList.remove('is-current');
    card.querySelector('a.memory-card-link')?.removeAttribute('aria-current');
  }
}

function syncUrl(options = {}) {
  const { replace = false } = options;
  const filters = state.filters;
  const nextUrl = buildAppUrl({
    spaceName: state.currentSpace?.name ?? null,
    view: state.spaceView,
    memoryName: state.currentMemory?.name ?? null,
    q: filters.q,
    tag: filters.tag,
    tiers: filters.tiers,
    confidence: filters.confidence || null,
    semantic: filters.semantic,
    isLogsPage: state.logsActive,
  });

  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;

  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextUrl);
}

/**
 * Reset the search slice when a route has no active in-space search.
 *
 * Search lives inside a space, so home and logs clear it entirely. Opening
 * another space starts from an empty query scoped to that space, which keeps a
 * previous space's results from leaking into the new header.
 *
 * @param {string | null} [spaceName]
 */
function resetSearchState(spaceName = null) {
  searchController.cancelPending();
  const search = searchStore.getState().search;
  searchStore.setState({
    search: {
      ...search,
      query: '',
      filters: {
        space: spaceName ?? '*',
        tag: state.filters.tag,
        tier: null,
        tiers: [...state.filters.tiers],
        confidence: state.filters.confidence || null,
      },
      semantic: state.filters.semantic,
      results: [],
      total: 0,
      hasMore: false,
      status: 'idle',
      error: null,
      offset: 0,
      currentSpace: spaceName ? { name: spaceName } : null,
    },
  });
}

function resetSearchScope() {
  state.currentSpace = null;
  resetSearchState(null);
  searchController.setScope(null);
}

/** True when the in-space search should replace the list surface. */
function hasListSearchCriteria() {
  return Boolean(state.filters.q.trim()) || state.filters.confidence !== '';
}

/**
 * Show the search results inside the space when a list-view query is active.
 * The map keeps its own surface: a query highlights nodes there instead of
 * replacing the canvas. It also keeps the shared filter bar's contextual
 * controls in sync with the active view.
 */
function updateSpaceSearchVisibility() {
  if (!elSpaceSearchView || !elListView) return;
  const isMap = state.spaceView === 'map';
  const showResults = Boolean(state.currentSpace) && !isMap && hasListSearchCriteria();
  elSpaceSearchView.classList.toggle('hidden', !showResults);
  elListView.classList.toggle('hidden', showResults || isMap);
  syncFilterBarControls();
}

function resetToHomeState() {
  resetSearchScope();
  state.currentSpace = null;
  state.currentMemory = null;
  state.memories = [];
  state.memoryTotal = 0;
  state.memoryHasMore = false;
  state.memoryOffset = 0;
  state.filters = clearFilters();
  state.tagOptions = [];
  resetTagOptionsForSpace();
  state.memoryStatus = 'idle';
  state.memoryError = null;
  state.memoryListSpace = null;
  state.memoryListKey = '';
  state.graph = createInitialGraphState();
  lastGraphSearchSignature = '';
  graphMount?.destroy();
  graphMount = null;
  elGraphView?.replaceChildren();
  elListView?.replaceChildren();
  closeLogsPage();
  panel.close();
  showPanel('empty');
  renderSidebar();
  // Keep a status payload that already loaded while this route was settling;
  // otherwise the rail falls back to the spaces.length placeholder and loses
  // the authoritative total on the first home render. Always prefer the global
  // payload: a space-scoped status reports only the open space.
  const homeStatus = state.globalStatus ?? state.status;
  if (homeStatus) {
    renderStatus(homeStatus);
  } else {
    renderStatusPlaceholder();
  }
  renderHomeView();
}

/**
 * Show the in-space search surface for a resolved space route. The space loads
 * first so the rail, header and status stay consistent with the
 * URL; the search page mounts inside the space and the controller adopts the
 * URL filters.
 *
 * @param {{ showSearch: boolean, spaceMode: boolean, currentSpace: { name: string } | null }} view
 * @param {ReturnType<typeof parseAppRoute>} route
 */
async function restoreSearchRoute(view, route) {
  await selectSpace(route.spaceName, {
    updateUrl: false,
    view: route.view,
    loadMemories: false,
    filters: {
      q: route.q,
      tag: route.tag,
      tiers: route.tiers,
      confidence: route.confidence ?? '',
      semantic: Boolean(route.semantic),
    },
  });

  showPanel('space');
  updateSpaceSearchVisibility();
  searchController.restoreFromUrl();
  updateSpaceSearchVisibility();
}

async function restoreRouteFromLocation() {
  // `/search` is no longer a route: canonicalize to home, or to the space the
  // user currently has open, before restoring state.
  if (window.location.pathname === '/search') {
    const fallback = state.currentSpace
      ? buildAppUrl({ spaceName: state.currentSpace.name, view: state.spaceView })
      : '/';
    window.history.replaceState({}, '', fallback);
  }

  const route = parseAppRoute(window.location.pathname, window.location.search);

  // Handle logs page
  if (route.isLogsPage) {
    resetSearchScope();
    showLogsPage();
    updateSpaceSearchVisibility();
    return;
  }

  const searchView = resolveSearchView(route);

  // A map URL that carries a query (`view=map&q=...`) is still the map: the
  // query highlights nodes in place. Only list routes show the results surface.
  const mapSearch = Boolean(route.spaceName) && route.view === 'map' && searchView.spaceMode;
  if (mapSearch) {
    const hasSpace = state.spaces.some(space => space.name === route.spaceName);
    if (!hasSpace) {
      resetToHomeState();
      syncUrl({ replace: true });
      return;
    }

    await selectSpace(/** @type {string} */ (route.spaceName), {
      updateUrl: false,
      view: 'map',
      filters: {
        q: route.q,
        tag: route.tag,
        tiers: route.tiers,
        confidence: route.confidence ?? '',
        semantic: Boolean(route.semantic),
      },
    });
    showPanel('space');
    setSpaceView('map', { updateUrl: false });
    searchController.restoreFromUrl();
    updateSpaceSearchVisibility();
    return;
  }

  if (searchView.showSearch) {
    const hasSpace = state.spaces.some(space => space.name === route.spaceName);
    if (!hasSpace) {
      resetToHomeState();
      syncUrl({ replace: true });
      return;
    }

    await restoreSearchRoute(searchView, route);
    return;
  }

  if (!route.spaceName) {
    resetToHomeState();
    syncUrl({ replace: true });
    return;
  }

  const hasSpace = state.spaces.some(space => space.name === route.spaceName);
  if (!hasSpace) {
    resetToHomeState();
    syncUrl({ replace: true });
    return;
  }

  await selectSpace(route.spaceName, {
    updateUrl: false,
    view: route.view,
    filters: {
      q: route.q,
      tag: route.tag,
      tiers: route.tiers,
      confidence: route.confidence ?? '',
      semantic: Boolean(route.semantic),
    },
  });

  if (route.memoryName) {
    // The memory may live beyond the first page, so open it directly. A failed
    // detail request surfaces the panel's error state with its retry action.
    await selectMemory(route.spaceName, route.memoryName, { updateUrl: false });
  }

  syncUrl({ replace: true });
  updateSpaceSearchVisibility();
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function loadSpaces() {
  const spaces = await listSpaces({ includeHidden: state.showHiddenSpaces });
  state.spaces = spaces.map(presentSpace);
  renderSidebar();
  // The search filter bar offers the space list, so refresh it when it changes.
  searchPage?.update();
  if (!state.currentSpace) {
    renderHomeView();
  }
}

async function selectSpace(name, options = {}) {
  const { updateUrl = true, view = state.spaceView, filters = {}, loadMemories = true } = options;
  state.currentSpace = state.spaces.find(s => s.name === name) ?? { name };
  state.currentMemory = null;
  state.graph = createInitialGraphState();
  lastGraphSearchSignature = '';
  closeLogsPage();
  state.filters = normalizeFilterState(filters);
  resetTagOptionsForSpace();
  resetSearchState(name);
  // `loadMemories: false` is used by space search routes: the search surface is
  // visible and the list is not needed yet. Leave the previous slice intact
  // instead of resetting to a loading state that no request will ever settle;
  // `ensureMemoryListLoaded` reconciles it when the space detail returns.
  if (loadMemories) {
    state.memories = [];
    state.memoryTotal = 0;
    state.memoryOffset = 0;
    state.memoryHasMore = false;
    state.memoryStatus = 'loading';
    state.memoryError = null;
  }
  panel.close();

  const [spaceData] = await Promise.all([getSpace(name), loadGraph(name), loadSpaceTags(name)]);
  state.currentSpace = spaceData;

  showPanel('space');
  renderSidebar();
  renderSpaceDetail();
  ensureSearchPage({ name });
  setSpaceView(view, { updateUrl: false });
  if (loadMemories) await loadMemoryPage({ reset: true, space: name });
  await loadStatus(spaceData.name);

  if (updateUrl) {
    syncUrl();
  }
}

async function refreshSpace(name) {
  const [spaceData] = await Promise.all([
    getSpace(name),
    loadGraph(name),
    loadSpaceTags(name),
    loadSpaces(),
    loadStatus(name),
  ]);
  state.currentSpace = spaceData;
  state.graph = { ...state.graph, selectedId: null };
  await loadMemoryPage({ reset: true, space: name });
  renderSpaceDetail();
}

/**
 * Open a memory in the panel. The dialog is revealed immediately in its loading
 * state; a monotonic request id plus an AbortController discard a stale detail
 * response when the user selects another memory (or closes) in the meantime.
 *
 * @param {string} spaceName
 * @param {string} memName
 * @param {{ updateUrl?: boolean, trigger?: Element | null }} [options]
 * @returns {Promise<void>}
 */
async function selectMemory(spaceName, memName, options = {}) {
  const { updateUrl = true, trigger = null } = options;
  const resolvedTrigger = trigger ?? findMemoryTrigger(memName);

  pendingMemorySelection = { spaceName, memName, trigger: resolvedTrigger };

  const requestId = ++memoryDetailRequestId;
  memoryDetailController?.abort();
  const controller = new AbortController();
  memoryDetailController = controller;

  state.currentMemory = null;
  panel.setLoading();
  panel.show({ trigger: resolvedTrigger });

  try {
    const memory = await getMemory(spaceName, memName, { signal: controller.signal });
    if (requestId !== memoryDetailRequestId || controller.signal.aborted) return;

    state.currentMemory = presentMemoryDetail(memory);
    panel.render(state.currentMemory);
    markCurrentMemory(state.currentMemory.name);

    if (updateUrl) {
      syncUrl();
    }
  } catch (err) {
    if (requestId !== memoryDetailRequestId || controller.signal.aborted) return;
    panel.setError(
      /** @type {any} */ (err)?.message || 'The memory could not be loaded. Try again.'
    );
  } finally {
    if (memoryDetailController === controller) memoryDetailController = null;
  }
}

/** Reload the memory whose detail request failed, keeping its focus target. */
function retryPendingMemory() {
  const pending = pendingMemorySelection;
  if (!pending) return;
  selectMemory(pending.spaceName, pending.memName, { trigger: pending.trigger });
}

/**
 * Apply a fresh memory DTO from a mutation to the panel and its list card.
 *
 * @param {Record<string, any>} updated
 */
function applyMemoryMutation(updated) {
  state.currentMemory = { ...state.currentMemory, ...presentMemoryDetail(updated) };
  const current = /** @type {Record<string, any>} */ (state.currentMemory);
  panel.render(current);
  updateMemoryCard(current.name, {
    content: current.content,
    tier: current.tier,
    pinned: current.pinned,
    tags: current.tags,
  });
}

/** @param {string} content */
async function handlePanelSave(content) {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { content });
    applyMemoryMutation(updated);
    showToast('Memory saved', 'success');
  } catch (err) {
    panel.setError(`Failed to save: ${err.message || 'Unknown error'}`);
  }
}

async function handlePanelPin() {
  const mem = state.currentMemory;
  if (!mem) return;
  const nextPinned = mem.pinned !== true;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { pinned: nextPinned });
    applyMemoryMutation(updated);
  } catch (err) {
    showToast(`Failed to update pin: ${err.message || 'Unknown error'}`, 'error');
  }
}

async function handlePanelPromote() {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { promote: true });
    applyMemoryMutation(updated);
  } catch (err) {
    showToast(`Failed to promote: ${err.message || 'Unknown error'}`, 'error');
  }
}

async function handlePanelDemote() {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { demote: true });
    applyMemoryMutation(updated);
  } catch (err) {
    showToast(`Failed to demote: ${err.message || 'Unknown error'}`, 'error');
  }
}

/**
 * Persist a tag entered through the inline input. The panel view owns the input
 * and its focus; the app owns the request and the refresh.
 *
 * @param {string} tag
 */
async function handlePanelAddTagSubmit(tag) {
  const mem = state.currentMemory;
  if (!mem) return;
  const value = String(tag ?? '')
    .trim()
    .toLowerCase();
  if (!value) return;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { addTag: value });
    applyMemoryMutation(updated);
    void loadSpaceTags(mem.space_name);
  } catch (err) {
    showToast(`Failed to add tag: ${err.message || 'Unknown error'}`, 'error');
  }
}

/** @param {string} tag */
async function handlePanelRemoveTag(tag) {
  const mem = state.currentMemory;
  if (!mem) return;
  try {
    const updated = await updateMemory(mem.space_name, mem.name, { removeTag: tag });
    applyMemoryMutation(updated);
    void loadSpaceTags(mem.space_name);
  } catch (err) {
    showToast(`Failed to remove tag: ${err.message || 'Unknown error'}`, 'error');
  }
}

function handlePanelDelete() {
  const mem = state.currentMemory;
  if (!mem) return;

  openDeleteConfirmation({
    title: 'Delete memory',
    message: `Delete memory "${mem.name}"? This cannot be undone.`,
    confirmLabel: 'Delete memory',
    trigger: $('btn-mem-delete'),
    onConfirm: async () => {
      try {
        await deleteMemory(mem.space_name, mem.name);
      } catch (err) {
        throw new Error(`Failed to delete memory: ${err.message || 'Unknown error'}`);
      }
      state.currentMemory = null;
      pendingMemorySelection = null;
      panel.close();
      removeMemoryParamFromUrl();
      clearCurrentMemoryHighlight();
      await refreshSpace(mem.space_name);
      syncUrl({ replace: true });
      showToast(`Memory "${mem.name}" deleted`, 'success');
    },
  });
}

// ── Inline editing ────────────────────────────────────────────────────────────
function makeEditable(el, onSave) {
  el.addEventListener('click', () => {
    const current = el.textContent;
    const input = document.createElement('input');
    input.value = current;
    input.className = el.className;
    input.style.background = 'var(--bg3)';
    input.style.border = '1px solid var(--accent)';
    input.style.borderRadius = '4px';
    input.style.padding = '2px 6px';
    input.style.color = 'var(--text)';
    input.style.width = '100%';
    el.replaceWith(input);
    input.focus();
    input.select();

    const done = async save => {
      if (save && input.value !== current) await onSave(input.value);
      input.replaceWith(el);
      if (save) el.textContent = input.value;
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      }
      if (e.key === 'Escape') done(false);
    });
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

// View toggle: segmented control with aria-pressed, roving tabindex and
// Arrow/Home/End navigation owned by the shell controller.
const viewToggle = setupViewToggle({
  document,
  window,
  onSelect: view => setSpaceView(view),
});

// Brand and logs links navigate through the SPA instead of reloading the page.
setupSpaNavigation({
  document,
  window,
  onNavigate: () => {
    restoreRouteFromLocation().catch(() => {
      resetToHomeState();
      syncUrl({ replace: true });
    });
  },
});

window.addEventListener('popstate', () => {
  restoreRouteFromLocation().catch(() => {
    resetToHomeState();
    syncUrl({ replace: true });
  });
});

// Search shortcuts: `/` focuses the open space's search input, arrows/Home/End
// walk result links and Escape clears the query or returns focus from a result.
// The helper is inert on home/logs (no input) and while the results surface is
// hidden, so it never intercepts keys on other views.
setupSearchKeyboard({
  document,
  getSearchInput: () => (state.currentSpace ? elSpaceSearch : null),
  getResultsRoot: () => elSpaceSearchView,
  isSearchVisible: () => isSearchSurfaceVisible(),
  onClearQuery: () => {
    clearSpaceSearch();
  },
});

// List keyboard navigation only engages on visible memory card links, so it
// never competes with the search shortcuts or the view-toggle Home/End.
setupMemoryKeyboard({
  document,
  getListRoot: () => elListView,
});

// Space title inline edit (rename)
makeEditable(elSpaceTitle, async newName => {
  const oldName = state.currentSpace.name;
  await updateSpace(oldName, { newName });
  state.currentSpace.name = newName;
  await loadSpaces();
  syncUrl({ replace: true });
});

// Space description inline edit
makeEditable(elSpaceDesc, async desc => {
  await updateSpace(state.currentSpace.name, { description: desc });
  state.currentSpace.description = desc;
});

// ── Create dialogs ────────────────────────────────────────────────────────────
// `createModal` owns open/close, focus return, Escape/backdrop dismissal and the
// alert region; the app owns validation, the request and the refresh effects.

/** @param {string} value */
function parseTags(value) {
  return String(value ?? '')
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Close a dialog when any `[data-modal-close]` control inside it is activated.
 *
 * @param {HTMLDialogElement} dialog
 * @param {{ close: () => void }} modal
 */
function bindModalCloseButtons(dialog, modal) {
  for (const button of dialog.querySelectorAll('[data-modal-close]')) {
    button.addEventListener('click', () => modal.close());
  }
}

const spaceDialog = /** @type {HTMLDialogElement} */ ($('modal-new-space'));
const spaceModal = createModal({ dialog: spaceDialog, document });
const spaceForm = spaceDialog.querySelector('[data-modal-form]');
const spaceCreateBtn = $('modal-space-create');

function resetSpaceForm() {
  $('new-space-name').value = '';
  $('new-space-desc').value = '';
  $('new-space-tags').value = '';
  renderFormErrors(spaceForm, {});
}

/** @param {Element | null} trigger */
function openSpaceModal(trigger) {
  renderFormErrors(spaceForm, {});
  spaceModal.open({ trigger });
}

async function submitSpaceModal() {
  const values = {
    name: $('new-space-name').value,
    description: $('new-space-desc').value,
    tags: $('new-space-tags').value,
  };
  if (!renderFormErrors(spaceForm, validateSpaceForm(values))) return;

  const name = values.name.trim();
  const description = values.description.trim();
  const tags = parseTags(values.tags);

  spaceCreateBtn.disabled = true;
  try {
    await createSpace({ name, description, tags });
    spaceModal.close();
    resetSpaceForm();
    await loadSpaces();
    await selectSpace(name);
    showToast(`Space "${name}" created`, 'success');
  } catch (err) {
    spaceModal.setError(`Failed to create space: ${err.message || 'Unknown error'}`);
  } finally {
    spaceCreateBtn.disabled = false;
  }
}

$('btn-new-space').addEventListener('click', () => openSpaceModal($('btn-new-space')));
$('modal-space-create').addEventListener('click', submitSpaceModal);
bindModalCloseButtons(spaceDialog, spaceModal);

// ── Delete confirmation dialog ────────────────────────────────────────────────
// One accessible confirmation for every destructive action (space, memory,
// space tag, logs). `createModal` owns open/close, focus return and the alert
// region; the app owns the request and its success effects.
const deleteDialog = /** @type {HTMLDialogElement} */ ($('modal-delete'));
const deleteModal = createModal({ dialog: deleteDialog, document });
const deleteTitleEl = $('modal-delete-title');
const deleteMessageEl = $('modal-delete-message');
const deleteConfirmBtn = $('modal-delete-confirm');

/** @type {(() => Promise<void>) | null} */
let pendingDeleteConfirm = null;

$('modal-delete-confirm').addEventListener('click', () => {
  pendingDeleteConfirm?.();
});
bindModalCloseButtons(deleteDialog, deleteModal);

/**
 * Open the delete confirmation. `onConfirm` runs on the confirm button; when it
 * resolves the dialog closes, and when it throws the message is announced in the
 * dialog and it stays open so the user can retry or cancel.
 *
 * @param {{
 *   title?: string,
 *   message?: string,
 *   confirmLabel?: string,
 *   onConfirm?: () => Promise<void> | void,
 *   trigger?: Element | null,
 * }} options
 */
function openDeleteConfirmation(options) {
  const { title, message, confirmLabel = 'Delete', onConfirm, trigger = null } = options;

  if (deleteTitleEl) deleteTitleEl.textContent = title || 'Confirm deletion';
  if (deleteMessageEl) deleteMessageEl.textContent = message || '';
  if (deleteConfirmBtn) deleteConfirmBtn.textContent = confirmLabel;
  deleteModal.clearError();
  deleteModal.open({ trigger });

  pendingDeleteConfirm = async () => {
    if (deleteConfirmBtn?.disabled) return;
    if (deleteConfirmBtn) deleteConfirmBtn.disabled = true;
    try {
      await onConfirm?.();
      pendingDeleteConfirm = null;
      deleteModal.close();
    } catch (err) {
      deleteModal.setError(/** @type {any} */ (err)?.message || 'Something went wrong. Try again.');
    } finally {
      if (deleteConfirmBtn) deleteConfirmBtn.disabled = false;
    }
  };
}

// Delete space
$('btn-delete-space').addEventListener('click', () => {
  const name = state.currentSpace?.name;
  if (!name) return;
  const trigger = $('btn-delete-space');

  openDeleteConfirmation({
    title: 'Delete space',
    message: `Delete space "${name}" and all its memories? This cannot be undone.`,
    confirmLabel: 'Delete space',
    trigger,
    onConfirm: async () => {
      try {
        await deleteSpace(name);
      } catch (err) {
        throw new Error(`Failed to delete space: ${err.message || 'Unknown error'}`);
      }
      resetToHomeState();
      syncUrl();
      await loadSpaces();
      showToast(`Space "${name}" deleted`, 'success');
    },
  });
});

// ── New memory dialog ─────────────────────────────────────────────────────────
const memoryDialog = /** @type {HTMLDialogElement} */ ($('modal-new-memory'));
const memoryModal = createModal({ dialog: memoryDialog, document });
const memoryForm = memoryDialog.querySelector('[data-modal-form]');
const memoryCreateBtn = $('modal-mem-create');

function resetMemoryForm() {
  $('new-mem-name').value = '';
  $('new-mem-content').value = '';
  $('new-mem-tags').value = '';
  $('new-mem-tier').value = '2';
  renderFormErrors(memoryForm, {});
}

/** @param {Element | null} trigger */
function openMemoryModal(trigger) {
  renderFormErrors(memoryForm, {});
  memoryModal.open({ trigger });
}

async function submitMemoryModal() {
  const values = {
    name: $('new-mem-name').value,
    content: $('new-mem-content').value,
    tags: $('new-mem-tags').value,
    tier: Number($('new-mem-tier').value),
  };
  if (!renderFormErrors(memoryForm, validateMemoryForm(values))) return;

  const spaceName = state.currentSpace?.name;
  if (!spaceName) return;

  const name = values.name.trim();
  const tags = parseTags(values.tags);

  memoryCreateBtn.disabled = true;
  try {
    await createMemory(spaceName, {
      name,
      content: values.content,
      tags,
      tier: values.tier,
    });
    memoryModal.close();
    resetMemoryForm();
    await refreshSpace(spaceName);
    showToast(`Memory "${name}" added`, 'success');
  } catch (err) {
    memoryModal.setError(`Failed to add memory: ${err.message || 'Unknown error'}`);
  } finally {
    memoryCreateBtn.disabled = false;
  }
}

$('btn-add-memory').addEventListener('click', () => openMemoryModal($('btn-add-memory')));
$('modal-mem-create').addEventListener('click', submitMemoryModal);
bindModalCloseButtons(memoryDialog, memoryModal);

/** The uncertainty guard: a control hidden while focused must hand focus off. */
function moveFocusOffHiddenControl(hiddenControl, fallback) {
  if (!hiddenControl || document.activeElement !== hiddenControl) return;
  const target =
    fallback ??
    (state.spaceView === 'map' ? $('btn-view-map') : $('btn-view-list')) ??
    elSpaceSearch;
  target?.focus();
}

// ── Tag select options ───────────────────────────────────────────────────────
// Options belong to the open space. A monotonic id plus AbortController makes
// a slow response for the previous space harmless, and the select DOM is only
// patched when it is not focused so a native dropdown never loses its state.
let tagOptionsRequestId = 0;
/** @type {AbortController | null} */
let tagOptionsController = null;
/** @type {string} */
let renderedTagOptionsSignature = '';
/** @type {boolean} */
let tagOptionsRenderPending = false;
/** @type {boolean} */
let tagSelectBlurBound = false;

/**
 * Load the memory tags for one space and patch the select when the response
 * still belongs to the open space. Failures are intentionally non-blocking:
 * the select keeps All tags and any selected URL tag as a temporary option.
 *
 * @param {string} spaceName
 */
async function loadSpaceTags(spaceName) {
  if (!spaceName) return;

  const requestId = ++tagOptionsRequestId;
  tagOptionsController?.abort();
  const controller = new AbortController();
  tagOptionsController = controller;

  const isCurrent = () =>
    requestId === tagOptionsRequestId &&
    !controller.signal.aborted &&
    state.currentSpace?.name === spaceName;

  try {
    const tags = await listSpaceMemoryTags(spaceName, { signal: controller.signal });
    if (!isCurrent()) return;
    state.tagOptions = Array.isArray(tags) ? tags : [];
    renderTagOptions();
  } catch {
    if (!isCurrent()) return;
    state.tagOptions = [];
    renderTagOptions();
  } finally {
    if (tagOptionsController === controller) tagOptionsController = null;
  }
}

/**
 * Drop the previous space's options immediately, aborting any in-flight load.
 * A focused select is blurred first so its stale options cannot stay visible
 * after the user navigates to another space.
 */
function resetTagOptionsForSpace() {
  tagOptionsRequestId += 1;
  tagOptionsController?.abort();
  tagOptionsController = null;
  state.tagOptions = [];
  if (document.activeElement === elFilterTag) elFilterTag?.blur();
  renderTagOptions();
}

/** Bind the one-time blur handoff that applies deferred option updates. */
function bindTagSelectBlur() {
  if (tagSelectBlurBound || !elFilterTag) return;
  tagSelectBlurBound = true;
  elFilterTag.addEventListener('blur', () => {
    if (!tagOptionsRenderPending) return;
    tagOptionsRenderPending = false;
    renderTagOptions();
  });
}

/**
 * Patch the Tag select from state: All tags, sorted server tags, and a
 * temporary selected option when a deep link points at a tag the latest
 * response does not include. Children are never replaced while the select has
 * focus; the update waits for blur.
 */
function renderTagOptions() {
  if (!elFilterTag) return;

  if (document.activeElement === elFilterTag) {
    tagOptionsRenderPending = true;
    bindTagSelectBlur();
    return;
  }

  const options = buildTagOptions(state.tagOptions, state.filters.tag);
  const signature = options
    .map(option => `${option.temporary ? '~' : ''}${option.value}`)
    .join('\u0000');

  if (signature !== renderedTagOptionsSignature) {
    const nodes = options.map(option => {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      return node;
    });
    elFilterTag.replaceChildren(...nodes);
    renderedTagOptionsSignature = signature;
  }

  if (elFilterTag.value !== state.filters.tag) elFilterTag.value = state.filters.tag;
  tagOptionsRenderPending = false;
}

/**
 * Patch the static filter bar from the shared state. Controls that only apply
 * to in-space search (confidence, embeddings) are hidden outside the search
 * surface; `Only matches` is map-only. Values are not written into a focused
 * control so typing is never clobbered by an async update.
 */
function syncFilterBarControls() {
  const filters = state.filters;
  const isMap = state.spaceView === 'map';
  const showSearchFields = Boolean(state.currentSpace) && !isMap && hasListSearchCriteria();
  const ragEnabled = state.status?.rag_enabled !== false;

  elTierChips.forEach((chip, index) => {
    if (!chip) return;
    const tier = index + 1;
    chip.setAttribute('aria-pressed', String(normalizeTiers(filters.tiers).includes(tier)));
  });

  if (elSpaceSearch && document.activeElement !== elSpaceSearch) {
    if (elSpaceSearch.value !== filters.q) elSpaceSearch.value = filters.q;
  }
  renderTagOptions();
  if (elFilterConfidence && document.activeElement !== elFilterConfidence) {
    if (elFilterConfidence.value !== filters.confidence) {
      elFilterConfidence.value = filters.confidence;
    }
  }
  if (elFilterSemantic) {
    elFilterSemantic.disabled = !ragEnabled;
    const checked = filters.semantic && ragEnabled;
    if (elFilterSemantic.checked !== checked) elFilterSemantic.checked = checked;
  }
  if (elFilterSemanticHelp) {
    elFilterSemanticHelp.textContent = ragEnabled
      ? 'Off by default. Uses the server embedding index when enabled.'
      : 'Embeddings are not enabled on this server.';
  }
  if (elFilterOnlyMatches && elFilterOnlyMatches.checked !== filters.onlyMatches) {
    elFilterOnlyMatches.checked = filters.onlyMatches;
  }

  if (elConfidenceField) elConfidenceField.hidden = !showSearchFields;
  if (elSemanticField) elSemanticField.hidden = !showSearchFields;
  if (elOnlyMatchesField) elOnlyMatchesField.hidden = !isMap;

  if (!showSearchFields) {
    moveFocusOffHiddenControl(elFilterConfidence);
    moveFocusOffHiddenControl(elFilterSemantic);
  }
  if (!isMap) moveFocusOffHiddenControl(elFilterOnlyMatches);

  if (elClearFilters) elClearFilters.disabled = !hasActiveFilters(filters);
}

/**
 * Apply a filter patch through the single shared state and URL owner.
 *
 * @param {Partial<import('./domain/filter-model.js').FilterState>} patch
 * @param {{ debounce?: boolean, replaceUrl?: boolean }} [options]
 */
function applySharedFilters(patch, options = {}) {
  const spaceName = state.currentSpace?.name ?? null;
  if (!spaceName) return;

  if (state.logsActive) closeLogsPage();
  if (state.currentMemory) {
    state.currentMemory = null;
    panel.close();
  }

  const spacePath = `/spaces/${enc(spaceName)}`;
  if (window.location.pathname !== spacePath) {
    window.history.replaceState({}, '', spacePath);
  }

  state.filters = normalizeFilterState({ ...state.filters, ...patch });
  state.memoryOffset = 0;
  syncUrl({ replace: options.replaceUrl === true });

  ensureSearchPage({ name: spaceName });
  searchController.setScope(spaceName);

  const wantsSearch = Boolean(state.filters.q.trim() || state.filters.confidence !== '');
  searchController.applyFilters(state.filters, {
    run: wantsSearch,
    debounce: options.debounce === true,
  });

  updateSpaceSearchVisibility();

  if (!wantsSearch) {
    if (state.spaceView !== 'map') ensureMemoryListLoaded();
    else renderGraphPanel();
    return;
  }
  if (state.spaceView === 'map') renderGraphPanel();
}

/** Reset every shared filter; the single global clear action. */
function clearAllFilters() {
  if (!state.currentSpace) return;
  state.filters = clearFilters();
  state.memoryOffset = 0;
  syncUrl();
  searchController.applyFilters(state.filters, { run: false });
  searchController.clearAll();
  updateSpaceSearchVisibility();
  syncFilterBarControls();
  if (state.spaceView !== 'map') ensureMemoryListLoaded();
  else renderGraphPanel();
}

/** @param {1|2|3} tier */
function toggleTier(tier) {
  const selected = new Set(normalizeTiers(state.filters.tiers));
  if (selected.has(tier)) selected.delete(tier);
  else selected.add(tier);
  const tiers = [...selected].sort((a, b) => a - b);
  applySharedFilters({ tiers: tiers.length === 0 ? [...ALL_TIERS] : tiers });
}

/** Clear only the query, preserving tiers and other filters. */
function clearSpaceSearch() {
  if (elSpaceSearch) elSpaceSearch.value = '';
  applySharedFilters({ q: '' }, { replaceUrl: true });
  if (state.spaceView !== 'map') {
    if (!hasListSearchCriteria()) ensureMemoryListLoaded();
    elSpaceSearch?.focus();
  }
}

elSpaceSearchForm?.addEventListener('submit', event => {
  event.preventDefault();
});

elSpaceSearch?.addEventListener('input', () => {
  const value = elSpaceSearch.value;
  if (!state.currentSpace) return;
  applySharedFilters({ q: value }, { debounce: true, replaceUrl: true });
});

elBtnClearSpaceSearch?.addEventListener('click', () => {
  clearSpaceSearch();
});

elFilterTag?.addEventListener('change', () => {
  applySharedFilters({ tag: elFilterTag.value });
});

elClearFilters?.addEventListener('click', () => {
  clearAllFilters();
});

elTierChips.forEach((chip, index) => {
  chip?.addEventListener('click', () => toggleTier(/** @type {1|2|3} */ (index + 1)));
});

elFilterConfidence?.addEventListener('change', () => {
  applySharedFilters({ confidence: /** @type {any} */ (elFilterConfidence.value) });
});

elFilterSemantic?.addEventListener('change', () => {
  applySharedFilters({ semantic: elFilterSemantic.checked === true });
});

elFilterOnlyMatches?.addEventListener('change', () => {
  applySharedFilters({ onlyMatches: elFilterOnlyMatches.checked === true });
});

// Keep the static controls aligned with the shared state after URL restore,
// popstate and programmatic clears.
searchStore.subscribe(() => {
  syncFilterBarControls();
});

// Escape/backdrop dismissal for the create dialogs is owned by `createModal`.

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function enc(str) {
  return encodeURIComponent(str);
}

// ── Toast notifications ─────────────────────────────────────────────────────────
let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

function showToast(message, type = 'success', duration = null) {
  ensureToastContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'polite');

  const iconName =
    type === 'success'
      ? 'circle-check'
      : type === 'error'
        ? 'circle-alert'
        : type === 'warning'
          ? 'triangle-alert'
          : null;

  if (iconName) {
    const icon = createIcon(iconName, { document });
    icon.classList.add('toast-icon', `toast-icon-${type}`);
    toast.appendChild(icon);
  }

  const messageNode = document.createElement('span');
  messageNode.className = 'toast-message';
  messageNode.textContent = message;
  toast.appendChild(messageNode);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.appendChild(createIcon('x', { document, size: 'sm' }));
  dismiss.addEventListener('click', () => dismissToast(toast));
  toast.appendChild(dismiss);

  toastContainer.appendChild(toast);

  // Auto-dismiss for success, manual for error/warning
  if (type === 'success') {
    const autoDuration = duration ?? 3000;
    setTimeout(() => {
      dismissToast(toast);
    }, autoDuration);
  }

  return toast;
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('toast-fade-out');
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 200);
}

// ── Logs ─────────────────────────────────────────────────────────────────────
// The logs surface is a single state slice rendered by `renderLogsView`. app.js
// owns the fetch, the polling lifecycle and the destructive clear action; the
// view owns the table, filters, pagination and accessibility semantics.

/** Monotonic request id + abort controller for the logs fetch. */
let logsRequestId = 0;
/** @type {AbortController | null} */
let logsRequestController = null;
/** @type {ReturnType<typeof setInterval> | null} */
let logsPollTimer = null;

/** True while the document is hidden (tab in the background). */
function isDocumentHidden() {
  return (
    (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') ||
    document.hidden === true
  );
}

/** @type {ReturnType<typeof createLogsPage> | null} */
let logsPage = null;

function createLogsPageInstance() {
  return createLogsPage({
    root: elLogsView,
    getState: () => state.logs,
    handlers: {
      onFilterChange: handleLogsFilterChange,
      onClearFilters: handleLogsClearFilters,
      onPageChange: handleLogsPageChange,
      onLiveChange: handleLogsLiveChange,
      onRetry: handleLogsRetry,
      onToggleDetails: handleLogsToggleDetails,
    },
  });
}

/**
 * Render the logs slice. The composition layer keeps the filters, live controls
 * and status live region mounted, so updates only replace the result body and
 * restore focus instead of dropping it to `body`.
 */
function renderLogsSurface() {
  if (!elLogsView || !state.logsActive) return;
  if (!logsPage) logsPage = createLogsPageInstance();
  logsPage.update();
}

/**
 * Fetch one page of logs. A stale response is discarded through a monotonic
 * request id plus an AbortController, and polling replaces (never appends) the
 * page so the DOM cannot grow without bound.
 *
 * @param {{ reset?: boolean, poll?: boolean }} [options]
 */
async function loadLogsPage(options = {}) {
  if (!state.logsActive) return;
  const { reset = false, poll = false } = options;
  const slice = state.logs;
  if (reset) slice.offset = 0;

  const requestId = ++logsRequestId;
  logsRequestController?.abort();
  const controller = new AbortController();
  logsRequestController = controller;

  slice.status = 'loading';
  slice.error = null;
  renderLogsSurface();

  const params = filterParams({
    ...slice.filters,
    limit: slice.limit,
    offset: poll ? 0 : slice.offset,
  });

  try {
    const response = await listLogs(params, { signal: controller.signal });
    if (requestId !== logsRequestId || controller.signal.aborted || !state.logsActive) return;

    const normalized = normalizeLogs(response);
    const capped = capLogRows(normalized.logs, 500);

    slice.logs = capped.logs;
    slice.dropped = capped.dropped;
    slice.total = normalized.total;
    slice.limit = normalized.limit;
    slice.offset = poll ? 0 : normalized.offset;
    slice.lastUpdatedAt = new Date().toISOString();
    slice.status = 'success';
    slice.error = null;
    renderLogsSurface();
  } catch (err) {
    if (requestId !== logsRequestId || controller.signal.aborted || !state.logsActive) return;
    slice.status = 'error';
    slice.error = err?.message || 'The logs could not be loaded. Try again.';
    renderLogsSurface();
  } finally {
    if (logsRequestController === controller) logsRequestController = null;
  }

  syncLogsPolling();
}

/** Start the polling interval unless one is already running. */
function startLogsPolling() {
  if (logsPollTimer !== null) return;
  logsPollTimer = setInterval(() => {
    if (!state.logsActive) {
      stopLogsPolling();
      return;
    }
    if (!shouldPoll(state.logs)) {
      stopLogsPolling();
      return;
    }
    void loadLogsPage({ poll: true });
  }, LOGS_POLL_INTERVAL_MS);
}

/** Stop the polling interval. Safe to call repeatedly. */
function stopLogsPolling() {
  if (logsPollTimer === null) return;
  clearInterval(logsPollTimer);
  logsPollTimer = null;
}

/**
 * Reconcile the interval with the polling policy: live + visible + settled. A
 * request in flight or a failed request pauses polling until it resolves or the
 * user retries.
 */
function syncLogsPolling() {
  if (!state.logsActive || !shouldPoll(state.logs)) {
    stopLogsPolling();
    return;
  }
  startLogsPolling();
}

/** Enter the logs route and load the first page. */
function showLogsPage() {
  state.logsActive = true;
  syncAllSpacesNav();
  state.logs = createInitialLogsState();
  state.logs.visible = !isDocumentHidden();

  showPanel('logs');
  // A fresh mount per visit clears any dirty-filter tracking from a previous
  // session while keeping the persistent pieces for this visit.
  logsPage?.destroy();
  logsPage = createLogsPageInstance();
  renderLogsSurface();
  void loadLogsPage({ reset: true });
}

/** Leave the logs route, stop polling and discard any in-flight request. */
function closeLogsPage() {
  state.logsActive = false;
  logsRequestId += 1;
  logsRequestController?.abort();
  logsRequestController = null;
  stopLogsPolling();
}

/** @param {string} name @param {string | number | null} value */
function handleLogsFilterChange(name, value) {
  state.logs.filters = { ...state.logs.filters, [name]: value ?? '' };
  state.logs.offset = 0;
  void loadLogsPage({ reset: true });
}

function handleLogsClearFilters() {
  state.logs.filters = { source: '', operation: '', level: '', search: '', from: '', to: '' };
  state.logs.offset = 0;
  void loadLogsPage({ reset: true });
}

/** @param {number} page */
function handleLogsPageChange(page) {
  if (!Number.isFinite(page) || page < 1) return;
  state.logs.offset = (page - 1) * state.logs.limit;
  void loadLogsPage();
}

/** @param {boolean} enabled */
function handleLogsLiveChange(enabled) {
  state.logs.live = enabled === true;
  renderLogsSurface();
  syncLogsPolling();
}

function handleLogsRetry() {
  void loadLogsPage();
}

/** @param {number | string} logId */
function handleLogsToggleDetails(logId) {
  const expanded =
    state.logs.expandedId !== null && String(state.logs.expandedId) === String(logId);
  state.logs.expandedId = expanded ? null : logId;
  renderLogsSurface();
}

function handleDocumentVisibilityChange() {
  state.logs.visible = !isDocumentHidden();
  if (state.logsActive) renderLogsSurface();
  syncLogsPolling();
}

document.addEventListener('visibilitychange', handleDocumentVisibilityChange);

// Clear all logs through the shared accessible confirmation dialog.
elBtnClearLogs?.addEventListener('click', () => {
  openDeleteConfirmation({
    title: 'Clear logs',
    message: 'Delete all logs? This cannot be undone.',
    confirmLabel: 'Clear all',
    trigger: elBtnClearLogs,
    onConfirm: async () => {
      try {
        await clearLogs();
      } catch (e) {
        throw new Error(`Failed to clear logs: ${e.message || 'Unknown error'}`);
      }
      state.logs.logs = [];
      state.logs.total = 0;
      state.logs.offset = 0;
      state.logs.dropped = 0;
      await loadLogsPage({ reset: true });
    },
  });
});

elToggleHiddenSpaces?.addEventListener('change', () => {
  state.showHiddenSpaces = elToggleHiddenSpaces.checked;
  loadSpaces();
});

// ── Mobile navigation drawer ───────────────────────────────────────────────────
// The shell controller is the single owner of drawer open/close state.
const shell = setupShell({ document, window });

// Close the drawer after selecting a space on a narrow viewport. `close()` is
// idempotent and harmless on desktop.
function closeSidebarOnSpaceSelect() {
  shell.close();
}

// Space navigation is one delegated binder per surface. Plain primary clicks
// stay inside the SPA; modifier and middle clicks fall through to the browser.
bindSpaceLinks(elSpaceList, {
  onSelect: name => {
    closeSidebarOnSpaceSelect();
    selectSpace(name);
  },
});

bindSpaceLinks(elEmptyState, {
  onSelect: name => selectSpace(name),
});

// All spaces search: local, in-memory filtering over already-loaded spaces.
// The shell is static, so these listeners bind once and the input survives
// every render. Clearing only resets the query and returns focus.
elHomeSearchForm?.addEventListener('submit', event => {
  event.preventDefault();
});

elHomeSearch?.addEventListener('input', () => {
  state.homeQuery = elHomeSearch.value;
  renderHomeView();
});

elBtnClearHomeSearch?.addEventListener('click', () => {
  state.homeQuery = '';
  if (elHomeSearch) {
    elHomeSearch.value = '';
    elHomeSearch.focus();
  }
  renderHomeView();
});

$('home-create-space')?.addEventListener('click', () => {
  openSpaceModal($('home-create-space'));
});

// Update close button visibility based on screen size
function updateCloseButtonVisibility() {
  const isMobile = window.innerWidth < 768;
  const btnBack = $('btn-mem-close');
  const btnInline = $('btn-mem-close-inline');
  if (btnBack && btnInline) {
    btnBack.style.display = isMobile ? 'flex' : 'none';
    btnInline.style.display = isMobile ? 'none' : 'flex';
  }
}

// Handle window resize for memory panel close buttons. Drawer resize handling
// lives inside the shell controller.
window.addEventListener('resize', () => {
  updateCloseButtonVisibility();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  updateCloseButtonVisibility();
  await loadSpaces();
  await loadStatus();
  await restoreRouteFromLocation();
}

boot().catch(() => {
  resetToHomeState();
});
