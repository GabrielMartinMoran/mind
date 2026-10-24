import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the in-space search.
 *
 * These boot the real `web/src/app.js` against the real shell markup with a
 * mocked `fetch`, so they cover the seam the unit tests cannot: the route, the
 * space-scoped search page, the controller scope and the outgoing
 * `/api/search` request must all agree. Search now lives inside the open space;
 * there is no global search input or `/search` page.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = 'projects/mind';

const MEMORY_DETAIL = {
  id: 'id-1',
  space_name: SPACE,
  name: 'mcp-agent-identity',
  content: 'Auth tokens protect the MCP identity.',
  tier: 2,
  pinned: false,
  tags: [],
  changed_at: '2026-10-21T00:00:00.000Z',
};

const SEARCH_RESULT = {
  id: 'id-1',
  space_name: SPACE,
  name: 'mcp-agent-identity',
  content: 'Auth tokens protect the MCP identity.',
  tier: 2,
  confidence: 'high',
  methods: ['trigram'],
  score: 0.82,
  tags: [],
  changed_at: '2026-10-21T00:00:00.000Z',
};

const GRAPH_NODES = [
  { id: 'n1', name: 'alpha', tier: 1, links_to: [], linked_by: [] },
  { id: 'n2', name: 'beta', tier: 2, links_to: [], linked_by: [] },
];

interface Harness {
  dom: DomHarness;
  requests: string[];
  searchRequests: URL[];
  queryRequests: URL[];
}

interface HarnessOptions {
  results?: unknown[];
}

function statusPayload() {
  return {
    total_spaces: 1,
    total_memories: 1,
    by_tier: [
      { tier: 1, count: 0 },
      { tier: 2, count: 1 },
      { tier: 3, count: 0 },
    ],
    rag_enabled: false,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function memorySummary() {
  return {
    id: 'id-1',
    space_name: SPACE,
    name: MEMORY_DETAIL.name,
    content: MEMORY_DETAIL.content,
    tier: 2,
    pinned: false,
    tags: [],
    changed_at: '2026-10-21T00:00:00.000Z',
  };
}

/** Build the shell DOM, install a `fetch` mock and boot the real app module. */
async function bootApp(
  url: string,
  scenario: string,
  options: HarnessOptions = {}
): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const requests: string[] = [];
  const searchRequests: URL[] = [];
  const queryRequests: URL[] = [];
  const searchResults = options.results ?? [];

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(raw);

    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);

    if (requestUrl.pathname === '/api/search') {
      searchRequests.push(requestUrl);
      return jsonResponse(searchResults, {
        'X-Total-Count': String(searchResults.length),
        'X-Has-More': 'false',
      });
    }

    if (requestUrl.pathname === '/api/memories/query') {
      queryRequests.push(requestUrl);
      return jsonResponse([memorySummary()], { 'X-Total-Count': '1' });
    }

    if (path === '/api/spaces') {
      return jsonResponse([
        {
          id: 'space-1',
          name: SPACE,
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: 1,
          hidden: false,
        },
      ]);
    }

    if (path === '/api/status') {
      return jsonResponse(statusPayload());
    }

    if (requestUrl.pathname === '/api/logs') {
      return jsonResponse({ logs: [], total: 0, limit: 100, offset: 0 });
    }

    if (path === `/api/spaces/${SPACE}`) {
      return jsonResponse({
        id: 'space-1',
        name: SPACE,
        description: 'Mind project space',
        tags: ['type:project'],
        hidden: false,
      });
    }

    if (path === `/api/spaces/${SPACE}/graph`) {
      return jsonResponse({ nodes: GRAPH_NODES, edges: [] });
    }

    if (path === `/api/spaces/${SPACE}/memories/${MEMORY_DETAIL.name}`) {
      return jsonResponse(MEMORY_DETAIL);
    }

    return jsonResponse([]);
  };

  const previousFetch = Reflect.get(globalThis, 'fetch');
  const previousMarked = Reflect.get(globalThis, 'marked');
  const previousLocation = Reflect.get(globalThis, 'location');
  const previousHistory = Reflect.get(globalThis, 'history');
  Reflect.set(globalThis, 'fetch', fetchMock);
  // The memory panel renders markdown through the vendored `marked` script that
  // index.html loads in a browser. The test only needs a pass-through parser.
  Reflect.set(globalThis, 'marked', { parse: (value: string) => value });
  // app.js and the search controller read the globals; keep them aligned with
  // the happy-dom window so history updates are observable in assertions.
  Reflect.set(globalThis, 'location', dom.window.location);
  Reflect.set(globalThis, 'history', dom.window.history);

  const previousCleanup = dom.cleanup;
  dom.cleanup = () => {
    Reflect.set(globalThis, 'fetch', previousFetch);
    Reflect.set(globalThis, 'marked', previousMarked);
    Reflect.set(globalThis, 'location', previousLocation);
    Reflect.set(globalThis, 'history', previousHistory);
    previousCleanup();
  };

  // Cache-bust the module URL so each test boots a fresh app instance with its
  // own module state; a plain import would run `boot()` only for the first test.
  await import(/* webpackIgnore: true */ `../src/app.js?wiring=${scenario}`);

  return { dom, requests, searchRequests, queryRequests };
}

/** Poll for a DOM condition with a bounded timeout; never a fixed sleep. */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function typeSpaceSearch(document: Document, window: DomHarness['window'], value: string): void {
  const input = document.getElementById('space-search') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
}

/** The panel controller owns native dialog semantics; detect `open` either way. */
function isPanelOpen(dom: DomHarness): boolean {
  const panel = dom.document.getElementById('memory-panel') as HTMLDialogElement | null;
  return panel !== null && (panel.open === true || panel.hasAttribute('open'));
}

function isHidden(dom: DomHarness, id: string): boolean {
  return dom.document.getElementById(id)?.classList.contains('hidden') === true;
}

function clickEl(dom: DomHarness, element: HTMLElement): void {
  element.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as never
  );
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('in-space search app wiring', () => {
  test('typing in the space header searches within the space and renders in context', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'space-scope', {
      results: [SEARCH_RESULT],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === SPACE,
      'the space route to restore'
    );

    typeSpaceSearch(dom.document, dom.window, 'auth');

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');

    const searchUrl = harness.searchRequests[0]!;
    expect(searchUrl.searchParams.get('q')).toBe('auth');
    expect(searchUrl.searchParams.get('space')).toBe(SPACE);

    // The static shared filter bar is visible and the search-only controls show.
    expect(dom.document.getElementById('space-filter-bar')).not.toBeNull();
    expect(dom.document.getElementById('space-filter-confidence-field')?.hidden).toBe(false);
    expect(dom.document.getElementById('space-filter-semantic-field')?.hidden).toBe(false);
    expect(dom.document.getElementById('space-search')?.getAttribute('value') ?? '').toBe('');

    // Results render inside the space; the list is hidden and the space header
    // (including the view toggle) stays visible.
    await waitFor(
      () => dom.document.querySelector('#space-search-view a.search-result-link') !== null,
      'the search result card'
    );
    expect(isHidden(dom, 'space-search-view')).toBe(false);
    expect(isHidden(dom, 'list-view')).toBe(true);
    expect(isHidden(dom, 'space-detail')).toBe(false);
    expect(dom.document.querySelector('#btn-view-list')).not.toBeNull();
    expect(dom.document.querySelector('#btn-view-map')).not.toBeNull();

    // No global search surface survives.
    expect(dom.document.getElementById('global-search')).toBeNull();
    expect(dom.document.getElementById('search-results')).toBeNull();

    expect(dom.window.location.pathname).toBe(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(dom.window.location.search).toContain('q=auth');
    expect(dom.window.location.pathname).not.toBe('/search');
  });

  test('a result click opens the panel and preserves the query and filters in the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'result-click', {
      results: [SEARCH_RESULT],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === SPACE,
      'the space route to restore'
    );

    typeSpaceSearch(dom.document, dom.window, 'auth');
    await waitFor(
      () => dom.document.querySelector('#space-search-view a.search-result-link') !== null,
      'the search result card'
    );

    const link = dom.document.querySelector(
      '#space-search-view a.search-result-link'
    ) as HTMLElement;
    link.dispatchEvent(
      new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as never
    );

    await waitFor(
      () => new URL(dom.window.location.href).searchParams.get('memory') === SEARCH_RESULT.name,
      'the result URL to be replaced'
    );

    const resultUrl = new URL(dom.window.location.href);
    expect(resultUrl.pathname).toBe(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(resultUrl.searchParams.get('q')).toBe('auth');
    expect(resultUrl.searchParams.get('memory')).toBe(SEARCH_RESULT.name);
    expect(isPanelOpen(dom)).toBe(true);
  });

  test('clearing the space search restores the memory list', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'clear-restores', {
      results: [SEARCH_RESULT],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#list-view .memory-card') !== null,
      'the memory list to load'
    );
    const initialListRequests = harness.queryRequests.length;

    typeSpaceSearch(dom.document, dom.window, 'auth');
    await waitFor(
      () => dom.document.querySelector('#space-search-view a.search-result-link') !== null,
      'the search result card'
    );
    expect(isHidden(dom, 'list-view')).toBe(true);

    const clear = dom.document.getElementById('btn-clear-space-search') as HTMLButtonElement;
    clear.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as never
    );

    await waitFor(() => isHidden(dom, 'space-search-view'), 'the results to hide');
    expect(isHidden(dom, 'list-view')).toBe(false);
    expect(dom.document.querySelector('#space-search-view a.search-result-link')).toBeNull();
    expect(dom.document.getElementById('space-search')).toHaveProperty('value', '');
    expect(new URL(dom.window.location.href).searchParams.has('q')).toBe(false);
    // The loaded list is reused instead of refetched.
    expect(harness.queryRequests.length).toBe(initialListRequests);
  });

  test('a map query keeps the map visible and highlights matches', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}?view=map`, 'map-search', {
      results: [
        {
          ...SEARCH_RESULT,
          id: 'n1',
          name: 'alpha',
        },
      ],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelectorAll('#graph-view g.graph-node').length === 2,
      'the map to render'
    );

    typeSpaceSearch(dom.document, dom.window, 'alpha');
    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    await waitFor(
      () => dom.document.querySelector('#graph-status')?.textContent === '1 match',
      'the match count to update in place'
    );

    // The map owns the surface; the results view stays hidden.
    expect(isHidden(dom, 'space-detail')).toBe(false);
    expect(isHidden(dom, 'graph-view')).toBe(false);
    expect(isHidden(dom, 'space-search-view')).toBe(true);
    expect(
      dom.document.querySelector('#graph-view g.graph-node[data-node-id="n1"]')?.classList
    ).toContain('is-match');

    const url = new URL(dom.window.location.href);
    expect(url.pathname).toBe(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(url.searchParams.get('view')).toBe('map');
    expect(url.searchParams.get('q')).toBe('alpha');
  });

  test('switching to the map keeps the active query in the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'map-preserves-query', {
      results: [SEARCH_RESULT],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === SPACE,
      'the space route to restore'
    );

    typeSpaceSearch(dom.document, dom.window, 'auth');
    await waitFor(() => harness.searchRequests.length === 1, 'the search request');

    clickEl(dom, dom.document.getElementById('btn-view-map') as HTMLElement);

    await waitFor(
      () =>
        Boolean(dom.document.getElementById('graph-view')?.classList.contains('hidden')) === false,
      'the map to become visible'
    );

    const url = new URL(dom.window.location.href);
    expect(url.searchParams.get('view')).toBe('map');
    expect(url.searchParams.get('q')).toBe('auth');
    expect(isHidden(dom, 'space-search-view')).toBe(true);
    expect(isHidden(dom, 'graph-view')).toBe(false);
  });

  test('visiting /search redirects to home and canonicalizes the URL', async () => {
    const harness = await bootApp('/search?q=auth', 'search-redirect');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => dom.window.location.pathname === '/', 'the /search redirect');
    expect(dom.window.location.search).toBe('');
    expect(harness.searchRequests).toHaveLength(0);
    expect(dom.document.getElementById('global-search')).toBeNull();
    expect(isHidden(dom, 'empty-state')).toBe(false);
  });

  test('"/" focuses the space search input while a space is open', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'slash-space');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === SPACE,
      'the space route to restore'
    );

    const input = dom.document.getElementById('space-search') as HTMLInputElement;
    const event = new dom.window.KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    });
    dom.document.body.dispatchEvent(event as never);

    expect(dom.document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });

  test('leaving the space for /logs cancels a pending search request', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'logs-cancel-pending');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === SPACE,
      'the space route to restore'
    );

    typeSpaceSearch(dom.document, dom.window, 'auth');

    const logsLink = dom.document.getElementById('logs-link') as HTMLElement;
    logsLink.dispatchEvent(
      new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }) as never
    );

    await waitFor(() => dom.window.location.pathname === '/logs', 'the logs route to open');

    // Let the debounce window (200ms) elapse; a cancelled timer must not fire.
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(harness.searchRequests).toHaveLength(0);
  });
});
