import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the paginated memory list.
 *
 * These boot the real `web/src/app.js` against the real shell markup with a
 * deterministic `fetch` mock. They cover the seam the pure view tests cannot:
 * the first-page request, filters in the URL, incremental pagination, the pin
 * mutation, the panel route and the error/retry state.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = 'projects/mind';

interface MemoryItem {
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: 1 | 2 | 3;
  pinned: boolean;
  tags: string[];
  changed_at: string;
}

interface PatchCall {
  pathname: string;
  method: string;
  body: unknown;
}

interface Harness {
  dom: DomHarness;
  queryRequests: URL[];
  searchRequests: URL[];
  patchCalls: PatchCall[];
}

interface HarnessOptions {
  total?: number;
  failFirstQuery?: boolean;
  /** Optional async gate before a query response, keyed by request index. */
  queryGate?: (request: URL, index: number) => Promise<void> | void;
  /** Search results returned by the mocked `/api/search` endpoint. */
  searchResults?: unknown[];
}

function memoryItem(index: number, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: `id-${index}`,
    space_name: SPACE,
    name: `memory-${String(index).padStart(3, '0')}`,
    content: `Content for memory ${index}`,
    tier: 2,
    pinned: false,
    tags: ['cat:decision'],
    changed_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Minimal search result payload accepted by the search view. */
function searchResultItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-001',
    space_name: SPACE,
    name: 'memory-001',
    content: 'Authentication content',
    tier: 2,
    pinned: false,
    tags: [],
    changed_at: '2026-10-20T10:00:00.000Z',
    score: 1,
    confidence: 'high',
    methods: ['fts5'],
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function statusPayload() {
  return {
    total_spaces: 1,
    total_memories: 250,
    by_tier: [
      { tier: 1, count: 0 },
      { tier: 2, count: 250 },
      { tier: 3, count: 0 },
    ],
    rag_enabled: false,
  };
}

/** Install a fresh DOM + fetch mock and boot the real app module. */
async function bootApp(
  url: string,
  scenario: string,
  options: HarnessOptions = {}
): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const total = options.total ?? 250;
  const queryRequests: URL[] = [];
  const searchRequests: URL[] = [];
  const patchCalls: PatchCall[] = [];
  let failNextQuery = options.failFirstQuery === true;

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);
    const method = init?.method ?? 'GET';

    if (requestUrl.pathname === '/api/search') {
      searchRequests.push(requestUrl);
      const results = options.searchResults ?? [];
      return jsonResponse(results, {
        'X-Total-Count': String(results.length),
        'X-Has-More': 'false',
      });
    }

    if (requestUrl.pathname === '/api/memories/query') {
      const index = queryRequests.length;
      queryRequests.push(requestUrl);
      await options.queryGate?.(requestUrl, index);
      if (failNextQuery) {
        failNextQuery = false;
        return new Response(JSON.stringify({ error: 'Memory query failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const limit = Number(requestUrl.searchParams.get('limit') ?? 100);
      const offset = Number(requestUrl.searchParams.get('offset') ?? 0);
      const requestedTier = Number(requestUrl.searchParams.get('tier') ?? 0);
      const itemTier = requestedTier === 1 || requestedTier === 3 ? requestedTier : 2;
      const count = Math.max(0, Math.min(limit, total - offset));
      const items = Array.from({ length: count }, (_, offsetIndex) =>
        memoryItem(offset + offsetIndex, { tier: itemTier as 1 | 2 | 3 })
      );
      return jsonResponse(items, { 'X-Total-Count': String(total) });
    }

    if (path === '/api/spaces') {
      return jsonResponse([
        {
          id: 'space-1',
          name: SPACE,
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: total,
          hidden: false,
        },
      ]);
    }

    if (path === '/api/status') {
      return jsonResponse(statusPayload());
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
      return jsonResponse({ nodes: [], edges: [] });
    }

    if (path === `/api/spaces/${SPACE}/tags`) {
      return jsonResponse(['cat:decision', 'status:living']);
    }

    if (path.startsWith(`/api/spaces/${SPACE}/memories/`)) {
      const name = path.slice(`/api/spaces/${SPACE}/memories/`.length);
      const index = Number(name.replace('memory-', '')) || 0;
      if (method === 'PATCH') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        patchCalls.push({ pathname: path, method, body });
        return jsonResponse(memoryItem(index, { pinned: body?.pinned === true }));
      }
      return jsonResponse(memoryItem(index));
    }

    if (path === `/api/spaces/${SPACE}/memories`) {
      return jsonResponse([]);
    }

    return jsonResponse([]);
  };

  const previousFetch = Reflect.get(globalThis, 'fetch');
  const previousMarked = Reflect.get(globalThis, 'marked');
  const previousLocation = Reflect.get(globalThis, 'location');
  const previousHistory = Reflect.get(globalThis, 'history');
  Reflect.set(globalThis, 'fetch', fetchMock);
  Reflect.set(globalThis, 'marked', { parse: (value: string) => value });
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

  await import(/* webpackIgnore: true */ `../src/app.js?memory-list=${scenario}`);

  return { dom, queryRequests, searchRequests, patchCalls };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Drain pending promise continuations without a fixed sleep. */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function click(dom: DomHarness, target: Element): any {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  } as never);
  target.dispatchEvent(event as never);
  return event;
}

function cards(dom: DomHarness): HTMLElement[] {
  return Array.from(dom.document.querySelectorAll<HTMLElement>('#list-view .memory-card'));
}

/** The panel controller owns native dialog semantics; detect `open` either way. */
function isPanelOpen(dom: DomHarness): boolean {
  const panel = dom.document.getElementById('memory-panel') as HTMLDialogElement | null;
  return panel !== null && (panel.open === true || panel.hasAttribute('open'));
}

function activeMemoryName(dom: DomHarness): string | null {
  const active = dom.document.activeElement as HTMLElement | null;
  return active?.closest('.memory-card')?.getAttribute('data-memory-name') ?? null;
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('memory list app wiring', () => {
  test('loads the first page with limit=100, offset=0 and the space, then reports the header total', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'first-page');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    expect(harness.queryRequests).toHaveLength(1);
    const request = harness.queryRequests[0]!;
    expect(request.searchParams.get('space')).toBe(SPACE);
    expect(request.searchParams.get('limit')).toBe('100');
    expect(request.searchParams.get('offset')).toBe('0');

    expect(dom.document.getElementById('memory-status')?.textContent).toBe(
      'Showing 100 of 250 memories'
    );
    expect(dom.document.getElementById('memory-show-more')).not.toBeNull();

    // The legacy all-memories request and tier lists are gone.
    expect(dom.document.querySelector('#tiers')).toBeNull();
    expect(dom.document.querySelector('#list-view .memory-tier')).not.toBeNull();
  });

  test('applies tier and tag filters to the request and the URL, then clears them', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'filters');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    // All three chips start active; disabling T2 keeps T1 and T3 inclusive.
    click(dom, dom.document.getElementById('space-tier-2') as HTMLElement);

    await waitFor(() => harness.queryRequests.length === 2, 'the multi-tier request');
    const tierRequest = harness.queryRequests[1]!;
    expect(tierRequest.searchParams.get('tiers')).toBe('1,3');
    expect(tierRequest.searchParams.get('tier')).toBeNull();
    expect(tierRequest.searchParams.get('offset')).toBe('0');
    expect(tierRequest.searchParams.get('space')).toBe(SPACE);
    expect(dom.window.location.search).toContain('tiers=1,3');

    const tag = dom.document.getElementById('space-filter-tag') as HTMLSelectElement;
    await waitFor(
      () => Array.from(tag.options).some(option => option.value === 'cat:decision'),
      'the memory tag options'
    );
    tag.value = 'cat:decision';
    tag.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    await waitFor(() => harness.queryRequests.length === 3, 'the tag-filtered request');
    const tagRequest = harness.queryRequests[2]!;
    expect(tagRequest.searchParams.get('tag')).toBe('cat:decision');
    expect(tagRequest.searchParams.get('tiers')).toBe('1,3');
    expect(dom.window.location.search).toContain('tag=cat%3Adecision');

    click(dom, dom.document.getElementById('space-clear-filters') as HTMLElement);

    await waitFor(() => harness.queryRequests.length === 4, 'the cleared request');
    const cleared = harness.queryRequests[3]!;
    expect(cleared.searchParams.has('tier')).toBe(false);
    expect(cleared.searchParams.has('tiers')).toBe(false);
    expect(cleared.searchParams.has('tag')).toBe(false);
    expect(cleared.searchParams.get('offset')).toBe('0');
    expect(dom.window.location.search).not.toContain('tier=');
    expect(dom.window.location.search).not.toContain('tag=');
  });

  test('restores tier and tag filters from the URL as list filters instead of search', async () => {
    const harness = await bootApp(
      '/spaces/projects%2Fmind?tier=2&tag=cat%3Adecision',
      'restore-filters'
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the filtered first page');

    const request = harness.queryRequests[0]!;
    expect(request.searchParams.get('tier')).toBe('2');
    expect(request.searchParams.get('tag')).toBe('cat:decision');

    expect(dom.document.getElementById('space-tier-1')?.getAttribute('aria-pressed')).toBe('false');
    expect(dom.document.getElementById('space-tier-2')?.getAttribute('aria-pressed')).toBe('true');
    expect(dom.document.getElementById('space-tier-3')?.getAttribute('aria-pressed')).toBe('false');
    expect((dom.document.getElementById('space-filter-tag') as HTMLSelectElement).value).toBe(
      'cat:decision'
    );
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      true
    );
    expect(dom.document.getElementById('space-detail')?.classList.contains('hidden')).toBe(false);
    expect(harness.searchRequests).toHaveLength(0);
  });

  test('changing a list filter keeps focus on the control and preserves the status live region', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'filter-focus');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    const tier = dom.document.getElementById('space-tier-1') as HTMLButtonElement;
    const status = dom.document.getElementById('memory-status') as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    tier.focus();
    expect(dom.document.activeElement).toBe(tier);

    click(dom, tier);

    // Wait for the app to finish the request and swap in the T2/T3 results.
    await waitFor(() => harness.queryRequests.length === 2, 'the tier-filtered request');

    expect(harness.queryRequests[1]!.searchParams.get('tiers')).toBe('2,3');
    expect(harness.queryRequests[1]!.searchParams.get('offset')).toBe('0');
    expect(dom.window.location.search).toContain('tiers=2,3');

    // The focused control is the same node and keeps focus across the update.
    expect(dom.document.getElementById('space-tier-1')).toBe(tier);
    expect(dom.document.activeElement).toBe(tier);
    // The live-region node identity is stable too.
    expect(dom.document.getElementById('memory-status')).toBe(status);
  });

  test('a space route with q opens search and skips the memory list fetch', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?q=auth', 'precedence-q');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');

    const request = harness.searchRequests[0]!;
    expect(request.searchParams.get('q')).toBe('auth');
    expect(request.searchParams.get('space')).toBe('projects/mind');

    // The list surface stays hidden and never issues its own query request.
    expect(harness.queryRequests).toHaveLength(0);
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      false
    );
    expect(dom.document.getElementById('list-view')?.classList.contains('hidden')).toBe(true);
    expect(dom.document.getElementById('space-detail')?.classList.contains('hidden')).toBe(false);
  });

  test('a space route with confidence opens search and skips the memory list fetch', async () => {
    const harness = await bootApp(
      '/spaces/projects%2Fmind?confidence=high',
      'precedence-confidence'
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');

    expect(harness.searchRequests[0]!.searchParams.get('confidence')).toBe('high');
    expect(harness.searchRequests[0]!.searchParams.get('space')).toBe('projects/mind');
    expect(harness.queryRequests).toHaveLength(0);
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      false
    );
  });

  test('dismissing a space search loads the list instead of stranding the loading state', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?q=auth', 'close-search-load');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    expect(harness.queryRequests).toHaveLength(0);

    click(dom, dom.document.getElementById('btn-clear-space-search') as HTMLElement);

    await waitFor(() => cards(dom).length === 100, 'the list to load after dismissing search');

    expect(harness.queryRequests).toHaveLength(1);
    const request = harness.queryRequests[0]!;
    expect(request.searchParams.get('space')).toBe(SPACE);
    expect(request.searchParams.get('offset')).toBe('0');
    expect(request.searchParams.get('limit')).toBe('100');
    expect(dom.document.getElementById('memory-status')?.textContent).toBe(
      'Showing 100 of 250 memories'
    );
    expect(dom.document.querySelector('#list-view .memory-skeleton-list')).toBeNull();
    expect(dom.document.getElementById('space-detail')?.classList.contains('hidden')).toBe(false);
  });

  test('closing a result-opened panel returns to the in-space search results', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?q=auth', 'panel-close-load', {
      searchResults: [searchResultItem()],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('.search-result-link') !== null,
      'the search result card'
    );
    // The space search route itself never loads the list.
    expect(harness.queryRequests).toHaveLength(0);

    click(dom, dom.document.querySelector('.search-result-link') as HTMLElement);

    await waitFor(() => isPanelOpen(dom) === true, 'the memory panel to open');
    expect(harness.queryRequests).toHaveLength(0);

    click(dom, dom.document.getElementById('btn-mem-close') as HTMLElement);

    await waitFor(() => isPanelOpen(dom) === false, 'the memory panel to close');

    // The query and results are preserved: closing the panel returns to the
    // search surface, not to an unloaded list.
    expect(harness.queryRequests).toHaveLength(0);
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      false
    );
    expect(dom.document.getElementById('list-view')?.classList.contains('hidden')).toBe(true);
    expect(dom.document.querySelector('.search-result-link')).not.toBeNull();
    expect(new URL(dom.window.location.href).searchParams.get('q')).toBe('auth');
    expect(dom.document.getElementById('space-detail')?.classList.contains('hidden')).toBe(false);
  });

  test('does not refetch an already loaded list when returning from a space search', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'no-duplicate-fetch');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');
    expect(harness.queryRequests).toHaveLength(1);

    const input = dom.document.getElementById('space-search') as HTMLInputElement;
    input.value = 'auth';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as never);

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      false
    );

    click(dom, dom.document.getElementById('btn-clear-space-search') as HTMLElement);
    await flushMicrotasks();

    // The list still matches the space and filters, so it is reused untouched.
    expect(harness.queryRequests).toHaveLength(1);
    expect(cards(dom)).toHaveLength(100);
    expect(dom.document.getElementById('memory-status')?.textContent).toBe(
      'Showing 100 of 250 memories'
    );
  });

  test('a stale slower filter response cannot overwrite a newer page', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const harness = await bootApp('/spaces/projects%2Fmind', 'stale-page', {
      queryGate: async request => {
        if (request.searchParams.get('tiers') === '2,3') await firstGate;
      },
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    // Disabling T1 starts a slow [2,3] request.
    click(dom, dom.document.getElementById('space-tier-1') as HTMLElement);
    await waitFor(() => harness.queryRequests.length === 2, 'the slow tiers=2,3 request');

    // Disabling T3 narrows the selection to T2 and overtakes the pending request.
    click(dom, dom.document.getElementById('space-tier-3') as HTMLElement);
    await waitFor(() => harness.queryRequests.length === 3, 'the newer tier=2 request');
    await waitFor(
      () => dom.document.querySelectorAll('#list-view .memory-card-tier.tier-2').length === 100,
      'the newer tier=2 results'
    );

    // Let the stale response arrive; the request-id guard must discard it.
    releaseFirst?.();
    await flushMicrotasks();

    expect(harness.queryRequests[2]!.searchParams.get('tier')).toBe('2');
    expect(dom.document.querySelectorAll('#list-view .memory-card-tier.tier-1')).toHaveLength(0);
    expect(dom.document.querySelectorAll('#list-view .memory-card-tier.tier-2')).toHaveLength(100);
    expect(dom.document.getElementById('memory-status')?.textContent).toBe(
      'Showing 100 of 250 memories'
    );
  });

  test('Show more requests offset=100, appends the next page and focuses the first new card', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'load-more');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    const showMore = dom.document.getElementById('memory-show-more') as HTMLButtonElement;
    expect(showMore.textContent).toBe('Show more');
    expect(showMore.querySelector('use')?.getAttribute('href')).toBe(
      '/assets/icons.svg#icon-chevron-down'
    );

    click(dom, showMore);

    await waitFor(() => cards(dom).length === 200, 'the appended second page');

    expect(harness.queryRequests).toHaveLength(2);
    const second = harness.queryRequests[1]!;
    expect(second.searchParams.get('offset')).toBe('100');
    expect(second.searchParams.get('limit')).toBe('100');
    expect(dom.document.getElementById('memory-status')?.textContent).toBe(
      'Showing 200 of 250 memories'
    );
    expect(activeMemoryName(dom)).toBe('memory-100');
  });

  test('cards expose no pin control and keep the panel as the pin surface', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'pin');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    const card = dom.document.querySelector(
      '.memory-card[data-memory-name="memory-000"]'
    ) as HTMLElement;
    const anchor = card.querySelector('a.memory-card-link') as HTMLAnchorElement;
    expect(card.querySelector('.memory-card-pin')).toBeNull();
    expect(anchor.firstElementChild?.classList.contains('memory-card-tier')).toBe(true);
    expect(anchor.lastElementChild?.classList.contains('memory-card-meta')).toBe(true);
    expect(anchor.lastElementChild?.querySelector('.memory-card-changed')?.textContent).toContain(
      'Changed'
    );

    click(dom, anchor);
    await waitFor(
      () =>
        isPanelOpen(dom) && dom.document.getElementById('mem-title')?.textContent === 'memory-000',
      'the memory panel to open'
    );

    const panelPin = dom.document.getElementById('btn-mem-pin') as HTMLButtonElement;
    expect(panelPin.getAttribute('aria-pressed')).toBe('false');
    click(dom, panelPin);

    await waitFor(
      () =>
        (dom.document.getElementById('btn-mem-pin') as HTMLButtonElement).getAttribute(
          'aria-pressed'
        ) === 'true',
      'the panel pin to apply'
    );

    expect(harness.patchCalls).toHaveLength(1);
    expect(harness.patchCalls[0]!.pathname).toBe(`/api/spaces/${SPACE}/memories/memory-000`);
    expect(harness.patchCalls[0]!.method).toBe('PATCH');
    expect(harness.patchCalls[0]!.body).toEqual({ pinned: true });
    expect(isPanelOpen(dom)).toBe(true);
  });

  test('clicking a card opens the memory panel and keeps memory in the URL', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'open-card');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cards(dom).length === 100, 'the first page of cards');

    const link = dom.document.querySelector(
      '.memory-card[data-memory-name="memory-001"] a.memory-card-link'
    ) as HTMLAnchorElement;
    click(dom, link);

    await waitFor(
      () =>
        isPanelOpen(dom) && dom.document.getElementById('mem-title')?.textContent === 'memory-001',
      'the memory panel to open and render'
    );

    expect(new URL(dom.window.location.href).searchParams.get('memory')).toBe('memory-001');
    expect(dom.document.getElementById('mem-title')?.textContent).toBe('memory-001');
  });

  test('a failed request shows the error state and retry reloads the current filters', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'error-retry', {
      failFirstQuery: true,
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#list-view .memory-error') !== null,
      'the error state'
    );

    expect(dom.document.querySelector('#list-view .memory-error')?.textContent).toContain(
      'Memory query failed'
    );
    expect(cards(dom)).toHaveLength(0);

    const retry = dom.document.getElementById('memory-retry') as HTMLButtonElement;
    expect(retry.textContent).toBe('Try again');
    expect(retry.querySelector('use')?.getAttribute('href')).toBe(
      '/assets/icons.svg#icon-rotate-ccw'
    );

    click(dom, retry);

    await waitFor(() => cards(dom).length === 100, 'the retried first page');

    expect(harness.queryRequests).toHaveLength(2);
    expect(harness.queryRequests[1]!.searchParams.get('offset')).toBe('0');
  });
});
