import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const shellCss = readFileSync(join(import.meta.dir, '../styles/components/shell.css'), 'utf8');

const SPACES = [
  {
    id: 'space-1',
    name: 'projects/mind',
    description: 'Long-term memory engine',
    tags: ['type:project', 'cat:decision'],
    memory_count: 3,
    tier_counts: { t1: 1, t2: 1, t3: 1 },
    hidden: false,
  },
  {
    id: 'space-2',
    name: 'projects/cafe',
    description: 'Diseño de memoria',
    tags: ['type:design'],
    memory_count: 2,
    tier_counts: { t1: 0, t2: 2, t3: 0 },
    hidden: false,
  },
  {
    id: 'space-3',
    name: 'sessions/mind',
    description: 'Session checkpoints',
    tags: ['type:session'],
    memory_count: 1,
    tier_counts: { t1: 0, t2: 0, t3: 1 },
    hidden: true,
  },
];

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function waitFor(predicate: () => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${message}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

function click(dom: DomHarness, target: EventTarget): void {
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event as unknown as Event);
}

function type(dom: DomHarness, input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event);
}

interface BootResult {
  dom: DomHarness;
  requests: string[];
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function bootApp(scenario: string, options: { url?: string } = {}): Promise<BootResult> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', options.url ?? '/');

  const requests: string[] = [];

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);
    requests.push(`${path}${requestUrl.search}`);

    if (path === '/api/spaces') return jsonResponse(SPACES);

    const space = SPACES.find(item => `/api/spaces/${item.name}` === path);
    if (space) return jsonResponse(space);

    if (path.endsWith('/graph')) {
      return jsonResponse({
        nodes: [],
        meta: { truncated: false, returned_nodes: 0, total_nodes: 0, applied_limit: 1000 },
      });
    }

    if (path === '/api/memories/query') return jsonResponse([], { 'X-Total-Count': '0' });

    if (path === '/api/status') {
      const scoped = requestUrl.searchParams.has('space');
      return jsonResponse({
        total_spaces: scoped ? 1 : 87,
        total_memories: scoped ? 2 : 1234,
        by_tier: [
          { tier: 1, count: 5 },
          { tier: 2, count: 10 },
          { tier: 3, count: 20 },
        ],
        rag_enabled: true,
      });
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

  await import(/* webpackIgnore: true */ `../src/app.js?home-search=${scenario}`);

  return { dom, requests };
}

function homeGridNames(dom: DomHarness): string[] {
  return Array.from(dom.document.querySelectorAll('#home-spaces .space-card')).map(card =>
    (card as HTMLElement).getAttribute('data-space-name')
  ) as string[];
}

async function bootHome(scenario: string): Promise<BootResult> {
  const result = await bootApp(scenario);
  await waitFor(() => homeGridNames(result.dom).length === 2, 'the home grid');
  return result;
}

describe('All spaces local search', () => {
  test('filters visible spaces and shows one result count without any backend search', async () => {
    const { dom, requests } = await bootHome('filter');
    cleanup = () => dom.cleanup();

    const input = dom.document.getElementById('home-search') as HTMLInputElement;
    expect(input).not.toBeNull();
    const before = requests.length;

    type(dom, input, 'cafe');

    expect(homeGridNames(dom)).toEqual(['projects/cafe']);
    expect(requests.length).toBe(before);

    const status = dom.document.getElementById('home-search-status') as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Showing 1 of 2 spaces');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(dom.document.querySelectorAll('#empty-state [aria-live="polite"]')).toHaveLength(1);

    expect(requests.some(url => url.startsWith('/api/search'))).toBe(false);
    expect(dom.window.location.pathname).toBe('/');
    expect(dom.window.location.search).toBe('');
  });

  test('matches accents, case and tags, and excludes hidden spaces', async () => {
    const { dom } = await bootHome('accents');
    cleanup = () => dom.cleanup();
    const input = dom.document.getElementById('home-search') as HTMLInputElement;

    type(dom, input, 'CAFE');
    expect(homeGridNames(dom)).toEqual(['projects/cafe']);

    type(dom, input, 'diseno');
    expect(homeGridNames(dom)).toEqual(['projects/cafe']);

    type(dom, input, 'type:project');
    expect(homeGridNames(dom)).toEqual(['projects/mind']);

    type(dom, input, 'session');
    expect(homeGridNames(dom)).toEqual([]);
  });

  test('requires every token to match somewhere across the fields', async () => {
    const { dom } = await bootHome('and-tokens');
    cleanup = () => dom.cleanup();
    const input = dom.document.getElementById('home-search') as HTMLInputElement;

    type(dom, input, 'mind engine');
    expect(homeGridNames(dom)).toEqual(['projects/mind']);

    type(dom, input, 'mind design');
    expect(homeGridNames(dom)).toEqual([]);
  });

  test('shows concise no-results text with no second clear button', async () => {
    const { dom } = await bootHome('no-results');
    cleanup = () => dom.cleanup();
    const input = dom.document.getElementById('home-search') as HTMLInputElement;

    type(dom, input, 'zzz');

    const noResults = dom.document.getElementById('home-no-results') as HTMLElement;
    expect(noResults.hidden).toBe(false);
    expect(noResults.textContent).toContain('No spaces match ‘zzz’');
    expect(noResults.querySelector('button')).toBeNull();

    const grid = dom.document.getElementById('home-spaces') as HTMLElement;
    const empty = dom.document.getElementById('home-empty') as HTMLElement;
    expect(grid.hidden).toBe(true);
    expect(empty.hidden).toBe(true);

    // Exactly one clear affordance: the in-field X inside the search form.
    expect(
      dom.document.querySelectorAll('#empty-state [aria-label="Clear space search"]')
    ).toHaveLength(1);
    expect(dom.document.getElementById('btn-clear-home-search')).not.toBeNull();
    expect(noResults.querySelector('button')).toBeNull();
  });

  test('keeps the create-space CTA for a true empty database', async () => {
    const dom = installDom();
    const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
    dom.document.body.innerHTML = parsed.body.innerHTML;
    dom.window.history.replaceState({}, '', '/');
    const previousFetch = Reflect.get(globalThis, 'fetch');
    Reflect.set(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, 'http://localhost').pathname;
      if (path === '/api/spaces') return jsonResponse([]);
      if (path === '/api/status') {
        return jsonResponse({
          total_spaces: 0,
          total_memories: 0,
          by_tier: [],
          rag_enabled: false,
        });
      }
      return jsonResponse([]);
    });
    const previousMarked = Reflect.get(globalThis, 'marked');
    const previousLocation = Reflect.get(globalThis, 'location');
    const previousHistory = Reflect.get(globalThis, 'history');
    Reflect.set(globalThis, 'marked', { parse: (value: string) => value });
    Reflect.set(globalThis, 'location', dom.window.location);
    Reflect.set(globalThis, 'history', dom.window.history);
    dom.cleanup = (() => {
      const base = dom.cleanup;
      return () => {
        Reflect.set(globalThis, 'fetch', previousFetch);
        Reflect.set(globalThis, 'marked', previousMarked);
        Reflect.set(globalThis, 'location', previousLocation);
        Reflect.set(globalThis, 'history', previousHistory);
        base();
      };
    })();
    cleanup = () => dom.cleanup();
    const emptyScenario = 'empty-db';
    await import(/* webpackIgnore: true */ `../src/app.js?home-search=${emptyScenario}`);

    await waitFor(
      () => (dom.document.getElementById('home-empty') as HTMLElement)?.hidden === false,
      'the empty database state'
    );

    const empty = dom.document.getElementById('home-empty') as HTMLElement;
    expect(empty.querySelector('#home-create-space')).not.toBeNull();
    expect((dom.document.getElementById('home-search-status') as HTMLElement).hidden).toBe(true);
  });
});

describe('All spaces search stability', () => {
  test('keeps the input node, value, caret and focus when spaces refresh', async () => {
    const { dom, requests } = await bootHome('stable-input');
    cleanup = () => dom.cleanup();

    const input = dom.document.getElementById('home-search') as HTMLInputElement;
    input.focus();
    type(dom, input, 'mind');
    input.setSelectionRange(2, 2);

    expect(document.activeElement).toBe(input);

    const toggle = dom.document.getElementById('toggle-hidden-spaces') as HTMLInputElement;
    const spacesRequests = () => requests.filter(url => url.startsWith('/api/spaces')).length;
    const before = spacesRequests();
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as unknown as Event);

    await waitFor(() => spacesRequests() > before, 'the spaces refresh');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(dom.document.getElementById('home-search')).toBe(input);
    expect(input.value).toBe('mind');
    expect(input.selectionStart).toBe(2);
    expect(dom.document.activeElement).toBe(input);
    // Hidden spaces stay out of All spaces even when the sidebar shows them.
    expect(homeGridNames(dom)).toEqual(['projects/mind']);
  });

  test('clear restores every visible space and focus without rebuilding the input', async () => {
    const { dom } = await bootHome('clear');
    cleanup = () => dom.cleanup();

    const input = dom.document.getElementById('home-search') as HTMLInputElement;
    type(dom, input, 'cafe');
    expect(homeGridNames(dom)).toEqual(['projects/cafe']);

    const clear = dom.document.getElementById('btn-clear-home-search') as HTMLButtonElement;
    expect(clear.hidden).toBe(false);
    click(dom, clear);

    expect(dom.document.getElementById('home-search')).toBe(input);
    expect(input.value).toBe('');
    expect(dom.document.activeElement).toBe(input);
    expect(homeGridNames(dom)).toEqual(['projects/mind', 'projects/cafe']);
    expect((dom.document.getElementById('home-search-status') as HTMLElement).hidden).toBe(true);
    expect(clear.hidden).toBe(true);
  });

  test('retains the query and filtered grid when returning from a space', async () => {
    const { dom } = await bootHome('return');
    cleanup = () => dom.cleanup();

    const input = dom.document.getElementById('home-search') as HTMLInputElement;
    type(dom, input, 'mind');
    expect(homeGridNames(dom)).toEqual(['projects/mind']);

    click(dom, dom.document.querySelector('#home-spaces .space-card') as Element);
    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route'
    );

    click(dom, dom.document.getElementById('all-spaces-link') as Element);
    await waitFor(
      () => dom.document.getElementById('empty-state')?.classList.contains('hidden') === false,
      'the home route'
    );

    expect(dom.document.getElementById('home-search')).toBe(input);
    expect(input.value).toBe('mind');
    expect(homeGridNames(dom)).toEqual(['projects/mind']);
    expect((dom.document.getElementById('home-search-status') as HTMLElement).textContent).toBe(
      'Showing 1 of 2 spaces'
    );
  });

  test('shows no scoped summary after visiting a space and restores the global sidebar status', async () => {
    const { dom } = await bootHome('scoped-status');
    cleanup = () => dom.cleanup();

    await waitFor(
      () =>
        dom.document.getElementById('status-spaces')?.textContent?.includes('87 spaces') === true,
      'the global status'
    );

    click(dom, dom.document.querySelector('#home-spaces .space-card') as Element);
    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route'
    );
    await waitFor(
      () =>
        dom.document.getElementById('status-spaces')?.textContent?.startsWith('1 space') === true,
      'the scoped status'
    );

    click(dom, dom.document.getElementById('all-spaces-link') as Element);
    await waitFor(
      () => dom.document.getElementById('empty-state')?.classList.contains('hidden') === false,
      'the home route'
    );

    expect(dom.document.getElementById('home-stats')).toBeNull();
    expect(dom.document.getElementById('empty-state')?.textContent).not.toMatch(
      /\d+\s+spaces?\s+·/
    );
    expect(dom.document.getElementById('status-spaces')?.textContent).toContain('87 spaces');
    expect(dom.document.getElementById('status-spaces')?.textContent).not.toContain('1 space');
    expect(dom.document.getElementById('space-count')?.textContent).toBe('87');
  });
});

describe('All spaces search markup and styles', () => {
  test('declares a compact, labelled search with a hidden custom clear control', () => {
    const dom = installDom();
    try {
      const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
      const input = parsed.querySelector('#home-search') as unknown as HTMLInputElement;
      const clear = parsed.querySelector('#btn-clear-home-search') as unknown as HTMLButtonElement;

      expect(input).not.toBeNull();
      expect(input.getAttribute('type')).toBe('text');
      expect(input.getAttribute('placeholder')).toBe('Search spaces by name, description or tag');

      const label =
        parsed.querySelector(`label[for="${input.id}"]`) ??
        parsed.getElementById(input.getAttribute('aria-labelledby') ?? '');
      expect(label?.textContent?.trim()).toBe('Search spaces');

      expect(clear).not.toBeNull();
      expect(clear.tagName).toBe('BUTTON');
      expect(clear.hasAttribute('hidden')).toBe(true);
      expect(clear.getAttribute('aria-label')).toBe('Clear space search');
      expect(parsed.querySelectorAll('#btn-clear-home-search')).toHaveLength(1);

      expect(parsed.querySelector('#home-stats')).toBeNull();
      expect(parsed.querySelector('.home-atlas-deck')?.textContent).not.toContain(
        'search across memories'
      );
    } finally {
      dom.cleanup();
    }
  });

  test('styles the home search compactly with a visible focus ring', () => {
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = shellCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      return match?.[1] ?? '';
    };

    const form = rule('.home-search');
    expect(form).toMatch(/position:\s*relative/);
    expect(form).toMatch(/max-width:\s*420px/);
    expect(form).toMatch(/display:\s*flex/);

    const input = rule(".home-search input[type='text']");
    expect(input).toMatch(/padding-right:\s*44px/);

    const focus = rule(".home-search input[type='text']:focus-visible");
    expect(focus).toMatch(/outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--accent\)/);

    const clear = rule('.home-search-clear');
    expect(clear).toMatch(/position:\s*absolute/);
    expect(clear).toMatch(/right:\s*6px/);

    expect(rule('.home-search-clear[hidden]')).toMatch(/display:\s*none/);
  });
});
