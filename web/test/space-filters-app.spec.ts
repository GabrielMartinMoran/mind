import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = 'projects/mind';

interface Harness {
  dom: DomHarness;
  searchRequests: URL[];
  queryRequests: URL[];
  tagRequests: URL[];
}

interface BootOptions {
  spaces?: string[];
  tagOptions?: Record<string, string[]>;
  tagGate?: (space: string, index: number) => Promise<void> | void;
  tagErrorFor?: string[];
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
    total_memories: 1,
    by_tier: [
      { tier: 1, count: 1 },
      { tier: 2, count: 0 },
      { tier: 3, count: 0 },
    ],
    rag_enabled: true,
  };
}

function memorySummary() {
  return {
    id: 'id-1',
    space_name: SPACE,
    name: 'memory-1',
    content: 'Auth content',
    tier: 1,
    pinned: false,
    tags: ['cat:decision'],
    changed_at: '2026-10-21T00:00:00.000Z',
  };
}

async function bootApp(url: string, scenario: string, options: BootOptions = {}): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const searchRequests: URL[] = [];
  const queryRequests: URL[] = [];
  const tagRequests: URL[] = [];
  const spaceNames = options.spaces ?? [SPACE];
  const tagOptions = options.tagOptions ?? { [SPACE]: ['cat:decision', 'status:living'] };

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);

    if (path.startsWith('/api/spaces/') && path.endsWith('/tags')) {
      const name = path.slice('/api/spaces/'.length, -'/tags'.length);
      const index = tagRequests.length;
      tagRequests.push(requestUrl);
      await options.tagGate?.(name, index);
      if (options.tagErrorFor?.includes(name)) {
        return new Response(JSON.stringify({ error: 'Tag options failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse(tagOptions[name] ?? []);
    }

    if (requestUrl.pathname === '/api/search') {
      searchRequests.push(requestUrl);
      return jsonResponse([], { 'X-Total-Count': '0', 'X-Has-More': 'false' });
    }

    if (requestUrl.pathname === '/api/memories/query') {
      queryRequests.push(requestUrl);
      return jsonResponse([memorySummary()], { 'X-Total-Count': '1' });
    }

    if (path === '/api/spaces') {
      return jsonResponse(
        spaceNames.map((name, index) => ({
          id: `space-${index + 1}`,
          name,
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: 1,
          hidden: false,
        }))
      );
    }

    if (path === '/api/status') return jsonResponse(statusPayload());

    const spaceName = spaceNames.find(name => path === `/api/spaces/${name}`);
    if (spaceName) {
      return jsonResponse({
        id: 'space-1',
        name: spaceName,
        description: 'Mind project space',
        tags: ['type:project'],
        hidden: false,
      });
    }

    const graphSpace = spaceNames.find(name => path === `/api/spaces/${name}/graph`);
    if (graphSpace) {
      return jsonResponse({ nodes: [{ id: 'n1', name: 'memory-1', tier: 1 }], edges: [] });
    }

    const detailSpace = spaceNames.find(name => path.startsWith(`/api/spaces/${name}/memories/`));
    if (detailSpace) {
      return jsonResponse({ ...memorySummary(), space_name: detailSpace, content: 'Auth content' });
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

  await import(/* webpackIgnore: true */ `../src/app.js?filters=${scenario}`);
  return { dom, searchRequests, queryRequests, tagRequests };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function click(dom: DomHarness, target: Element): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }) as never
  );
}

function typeSearch(dom: DomHarness, value: string): void {
  const input = dom.document.getElementById('space-search') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as never);
}

function tagSelect(dom: DomHarness): HTMLSelectElement {
  return dom.document.getElementById('space-filter-tag') as HTMLSelectElement;
}

function selectTag(dom: DomHarness, value: string): void {
  const select = tagSelect(dom);
  select.value = value;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);
}

function optionValues(dom: DomHarness): string[] {
  return Array.from(tagSelect(dom).options).map(option => option.value);
}

function spaceLink(dom: DomHarness, name: string): HTMLAnchorElement {
  return dom.document.querySelector(`a[data-space-name="${name}"]`) as HTMLAnchorElement;
}

/** Drain pending promise continuations without a fixed sleep. */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function chip(dom: DomHarness, tier: 1 | 2 | 3): HTMLButtonElement {
  return dom.document.getElementById(`space-tier-${tier}`) as HTMLButtonElement;
}

function pressed(dom: DomHarness, tier: 1 | 2 | 3): string | null {
  return chip(dom, tier).getAttribute('aria-pressed');
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('shared space filter bar app wiring', () => {
  test('renders exactly one filter bar and one clear action', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'single-bar');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelectorAll('#list-view .memory-card').length === 1,
      'the list to load'
    );

    expect(dom.document.querySelectorAll('#space-filter-bar')).toHaveLength(1);
    expect(dom.document.querySelectorAll('#space-clear-filters')).toHaveLength(1);
    expect(dom.document.querySelectorAll('.space-filter-primary')).toHaveLength(1);
    expect(dom.document.querySelectorAll('.space-filter-controls')).toHaveLength(0);

    const bar = dom.document.getElementById('space-filter-bar')!;
    for (const id of [
      'space-search',
      'space-filter-tag',
      'space-tier-1',
      'space-tier-2',
      'space-tier-3',
      'space-filter-confidence',
      'space-filter-semantic',
      'space-filter-only-matches',
      'space-clear-filters',
    ]) {
      expect(bar.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(dom.document.getElementById('memory-clear-filters')).toBeNull();
    expect(dom.document.getElementById('search-clear-all')).toBeNull();
    expect(pressed(dom, 1)).toBe('true');
    expect(pressed(dom, 2)).toBe('true');
    expect(pressed(dom, 3)).toBe('true');
  });

  test('populates the Tag select with All tags plus sorted memory tags', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'tag-options');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => optionValues(dom).length === 3, 'the tag options to load');

    expect(tagSelect(dom).tagName).toBe('SELECT');
    expect(dom.document.querySelector('input#space-filter-tag')).toBeNull();
    expect(optionValues(dom)).toEqual(['', 'cat:decision', 'status:living']);
    expect(tagSelect(dom).options[0]!.textContent).toBe('All tags');
    expect(tagSelect(dom).value).toBe('');
  });

  test('an empty memory-tag list leaves only All tags', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'empty-tags', {
      tagOptions: { [SPACE]: [] },
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.tagRequests.length === 1, 'the tag options request');
    await flushMicrotasks();
    expect(optionValues(dom)).toEqual(['']);
    expect(tagSelect(dom).value).toBe('');
  });

  test('selecting a tag updates the list request, URL and map state without searching', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'tag-only');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');
    await waitFor(() => optionValues(dom).includes('cat:decision'), 'the memory tag options');

    selectTag(dom, 'cat:decision');
    await waitFor(() => harness.queryRequests.length === 2, 'the tag-filtered list request');

    expect(harness.queryRequests[1]!.searchParams.get('tag')).toBe('cat:decision');
    expect(dom.window.location.search).toContain('tag=cat%3Adecision');
    expect(harness.searchRequests).toHaveLength(0);

    click(dom, dom.document.getElementById('btn-view-map') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-filter-only-matches-field')?.hidden === false,
      'the map controls'
    );
    expect(tagSelect(dom).value).toBe('cat:decision');
    expect(dom.window.location.search).toContain('tag=cat%3Adecision');
    expect(harness.searchRequests).toHaveLength(0);
  });

  test('a missing deep-linked tag becomes a temporary option and survives option refresh', async () => {
    const harness = await bootApp(
      `/spaces/${encodeURIComponent(SPACE)}?tag=legacy%3Atag`,
      'temporary-tag',
      { tagOptions: { [SPACE]: ['alpha'] } }
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the deep-linked list request');
    await waitFor(() => optionValues(dom).includes('legacy:tag'), 'the temporary tag option');

    expect(optionValues(dom)).toEqual(['', 'alpha', 'legacy:tag']);
    expect(tagSelect(dom).value).toBe('legacy:tag');
    expect(tagSelect(dom).selectedOptions[0]?.textContent).toBe('legacy:tag');
    expect(harness.queryRequests[0]!.searchParams.get('tag')).toBe('legacy:tag');
    expect(dom.window.location.search).toContain('tag=legacy%3Atag');
  });

  test('a missing deep-linked tag survives a failed non-blocking option load', async () => {
    const harness = await bootApp(
      `/spaces/${encodeURIComponent(SPACE)}?tag=legacy%3Atag`,
      'temporary-tag-error',
      { tagErrorFor: [SPACE] }
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.tagRequests.length === 1, 'the failed tag request');
    await waitFor(() => harness.queryRequests.length === 1, 'the deep-linked list request');
    await flushMicrotasks();

    expect(optionValues(dom)).toEqual(['', 'legacy:tag']);
    expect(tagSelect(dom).value).toBe('legacy:tag');
    expect(dom.window.location.search).toContain('tag=legacy%3Atag');
  });

  test('a stale tag response from a previous space cannot overwrite the current options', async () => {
    const slowSpace = 'projects/slow';
    const currentSpace = 'projects/current';
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve;
    });

    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'stale-tags', {
      spaces: [SPACE, slowSpace, currentSpace],
      tagOptions: {
        [SPACE]: ['first:tag'],
        [slowSpace]: ['slow:tag'],
        [currentSpace]: ['current:tag'],
      },
      tagGate: async space => {
        if (space === slowSpace) await slowGate;
      },
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => optionValues(dom).includes('first:tag'), 'the first space options');

    click(dom, spaceLink(dom, slowSpace));
    await waitFor(
      () =>
        harness.tagRequests.some(url =>
          decodeURIComponent(url.pathname).endsWith(`/${slowSpace}/tags`)
        ),
      'the slow space tag request'
    );

    click(dom, spaceLink(dom, currentSpace));
    await waitFor(() => optionValues(dom).includes('current:tag'), 'the current space options');

    releaseSlow?.();
    await flushMicrotasks();

    expect(optionValues(dom)).toEqual(['', 'current:tag']);
    expect(tagSelect(dom).value).toBe('');
  });

  test('keeps the select node and focus while options load, then updates on blur', async () => {
    let releaseTags: (() => void) | null = null;
    const tagsGate = new Promise<void>(resolve => {
      releaseTags = resolve;
    });

    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'focused-tags', {
      tagGate: async () => {
        await tagsGate;
      },
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.tagRequests.length === 1, 'the gated tag request');
    const select = tagSelect(dom);
    const allOption = select.options[0]!;
    select.focus();
    expect(dom.document.activeElement).toBe(select);

    releaseTags?.();
    await flushMicrotasks();

    // Options are deferred while the control is focused; node and focus survive.
    expect(tagSelect(dom)).toBe(select);
    expect(select.options[0]).toBe(allOption);
    expect(optionValues(dom)).toEqual(['']);
    expect(dom.document.activeElement).toBe(select);

    select.blur();
    await waitFor(() => optionValues(dom).includes('cat:decision'), 'the deferred options');

    expect(tagSelect(dom)).toBe(select);
    expect(optionValues(dom)).toEqual(['', 'cat:decision', 'status:living']);
  });

  test('tier chips are inclusive multi-select and write tier/tiers to the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'multi-tier');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');

    click(dom, chip(dom, 2));
    await waitFor(() => harness.queryRequests.length === 2, 'the two-tier request');
    expect(harness.queryRequests[1]!.searchParams.get('tiers')).toBe('1,3');
    expect(pressed(dom, 2)).toBe('false');
    expect(dom.window.location.search).toContain('tiers=1,3');

    click(dom, chip(dom, 3));
    await waitFor(() => harness.queryRequests.length === 3, 'the single-tier request');
    expect(harness.queryRequests[2]!.searchParams.get('tier')).toBe('1');
    expect(harness.queryRequests[2]!.searchParams.has('tiers')).toBe(false);
    expect(dom.window.location.search).toContain('tier=1');
  });

  test('list → map → search keeps the same bar node and state', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'same-bar');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');
    const bar = dom.document.getElementById('space-filter-bar');

    click(dom, chip(dom, 2));
    await waitFor(() => pressed(dom, 2) === 'false', 'the tier to toggle off');

    click(dom, dom.document.getElementById('btn-view-map') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-filter-only-matches-field')?.hidden === false,
      'only-matches to show on the map'
    );
    expect(dom.document.getElementById('space-filter-bar')).toBe(bar);
    expect(pressed(dom, 2)).toBe('false');

    typeSearch(dom, 'auth');
    await waitFor(() => harness.searchRequests.length === 1, 'the in-space search request');
    expect(dom.document.getElementById('space-filter-bar')).toBe(bar);
    expect(pressed(dom, 2)).toBe('false');

    click(dom, dom.document.getElementById('btn-view-list') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-filter-confidence-field')?.hidden === false,
      'search controls to show in the list search view'
    );
    expect(dom.document.getElementById('space-filter-only-matches-field')?.hidden).toBe(true);
    expect(dom.document.getElementById('space-filter-bar')).toBe(bar);
  });

  test('the in-field X clears only the query and keeps tiers', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'query-x');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');
    click(dom, chip(dom, 2));
    await waitFor(() => harness.queryRequests.length === 2, 'the tier request');

    typeSearch(dom, 'auth');
    await waitFor(() => harness.searchRequests.length === 1, 'the search request');

    click(dom, dom.document.getElementById('btn-clear-space-search') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-search-view')?.classList.contains('hidden') === true,
      'the restored list view'
    );

    expect(dom.document.getElementById('list-view')?.classList.contains('hidden')).toBe(false);
    expect((dom.document.getElementById('space-search') as HTMLInputElement).value).toBe('');
    expect(pressed(dom, 2)).toBe('false');
    expect(new URL(dom.window.location.href).searchParams.get('q')).toBeNull();
    expect(new URL(dom.window.location.href).searchParams.get('tiers')).toBe('1,3');
  });

  test('Clear filters resets every shared filter and no empty state has a clear button', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'clear-all');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');

    click(dom, chip(dom, 2));
    await waitFor(() => pressed(dom, 2) === 'false', 'tier toggled');

    await waitFor(() => optionValues(dom).includes('cat:decision'), 'the memory tag options');
    selectTag(dom, 'cat:decision');
    await waitFor(() => harness.queryRequests.length === 3, 'the tag-filtered request');

    typeSearch(dom, 'auth');
    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    expect(harness.searchRequests[0]!.searchParams.get('tag')).toBe('cat:decision');

    const confidence = dom.document.getElementById('space-filter-confidence') as HTMLSelectElement;
    confidence.value = 'high';
    confidence.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    const semantic = dom.document.getElementById('space-filter-semantic') as HTMLInputElement;
    semantic.checked = true;
    semantic.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    click(dom, dom.document.getElementById('btn-view-map') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-filter-only-matches-field')?.hidden === false,
      'map controls'
    );
    const onlyMatches = dom.document.getElementById(
      'space-filter-only-matches'
    ) as HTMLInputElement;
    onlyMatches.checked = true;
    onlyMatches.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    click(dom, dom.document.getElementById('btn-view-list') as HTMLElement);
    await waitFor(
      () => dom.document.getElementById('space-filter-confidence-field')?.hidden === false,
      'search controls'
    );

    click(dom, dom.document.getElementById('space-clear-filters') as HTMLElement);
    await waitFor(() => pressed(dom, 1) === 'true' && pressed(dom, 2) === 'true', 'tiers to reset');

    expect((dom.document.getElementById('space-search') as HTMLInputElement).value).toBe('');
    expect(tagSelect(dom).value).toBe('');
    expect(confidence.value).toBe('');
    expect(semantic.checked).toBe(false);
    expect(onlyMatches.checked).toBe(false);
    expect(dom.document.getElementById('space-clear-filters')?.hasAttribute('disabled')).toBe(true);
    expect(new URL(dom.window.location.href).search).toBe('');

    expect(dom.document.getElementById('memory-no-match-clear')).toBeNull();
    expect(dom.document.getElementById('search-empty-action')).toBeNull();
    expect(dom.document.querySelector('.memory-empty-action')).toBeNull();
  });

  test('a list-only filter change never fires a hidden /api/search request', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'no-hidden-search');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.queryRequests.length === 1, 'the first list page');
    click(dom, chip(dom, 2));
    await waitFor(() => harness.queryRequests.length === 2, 'the tier list request');

    await waitFor(() => optionValues(dom).includes('cat:decision'), 'the memory tag options');
    selectTag(dom, 'cat:decision');
    await waitFor(() => harness.queryRequests.length === 3, 'the tag list request');

    expect(harness.searchRequests).toHaveLength(0);
  });

  test('a deep link with tiers=1,3 restores chips and the list request after reload', async () => {
    for (const scenario of ['deep-link-boot', 'deep-link-reload']) {
      const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}?tiers=1,3`, scenario);
      try {
        await waitFor(() => harness.queryRequests.length === 1, 'the deep-linked list page');
        expect(pressed(harness.dom, 1)).toBe('true');
        expect(pressed(harness.dom, 2)).toBe('false');
        expect(pressed(harness.dom, 3)).toBe('true');
        expect(harness.queryRequests[0]!.searchParams.get('tiers')).toBe('1,3');
        expect(harness.dom.window.location.search).toContain('tiers=1,3');
      } finally {
        harness.dom.cleanup();
      }
    }
  });
});
