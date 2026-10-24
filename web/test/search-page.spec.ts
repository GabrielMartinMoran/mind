import { describe, expect, test } from 'bun:test';

import { createSearchPage } from '../src/app/search-page.js';
import { createStore } from '../src/app/store.js';

import { installDom, type DomHarness } from './helpers/dom';

interface SearchResultFixture {
  id: string;
  space_name: string;
  name: string;
  content?: string;
  tier?: number;
  confidence?: string;
  methods?: string[];
  score?: number;
  tags?: string[];
}

function result(overrides: Partial<SearchResultFixture> = {}): SearchResultFixture {
  return {
    id: 'id-1',
    space_name: 'projects/mind',
    name: 'mcp-agent-identity',
    content: 'The MCP agent identity uses auth tokens for graph queries.',
    tier: 2,
    confidence: 'high',
    methods: ['trigram', 'token_set'],
    score: 0.82,
    tags: ['cat:decision', 'type:learning'],
    ...overrides,
  };
}

function baseSearch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: '',
    filters: { space: '*', tag: '', tier: null, tiers: [], confidence: null },
    semantic: false,
    results: [],
    total: 0,
    hasMore: false,
    status: 'success',
    error: null,
    offset: 0,
    ...overrides,
  };
}

type ControllerCall = [string, ...unknown[]];

function createControllerSpy() {
  const calls: ControllerCall[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    retry: record('retry'),
    loadMore: record('loadMore'),
  };
}

interface PageHarness {
  dom: DomHarness;
  store: ReturnType<typeof createStore>;
  controller: ReturnType<typeof createControllerSpy>;
  root: HTMLElement;
  page: ReturnType<typeof createSearchPage>;
  opened: unknown[];
}

function createPage(
  dom: DomHarness,
  options: {
    search?: Record<string, unknown>;
    controller?: ReturnType<typeof createControllerSpy>;
  } = {}
): PageHarness {
  const store = createStore({
    search: baseSearch(options.search),
    spaces: [],
    status: { rag_enabled: true },
  });
  const controller = options.controller ?? createControllerSpy();
  const opened: unknown[] = [];
  const root = dom.document.createElement('div');
  root.id = 'space-search-view';
  dom.document.body.appendChild(root);

  const page = createSearchPage({
    root,
    store,
    controller,
    getStatus: () => (store.getState() as any).status,
    onOpenResult: (item: unknown) => opened.push(item),
    document: dom.document,
  });

  return { dom, store, controller, root, page, opened };
}

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

function click(dom: DomHarness, target: Element): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }) as never
  );
}

describe('search page mount', () => {
  test('renders only the results region and polite status once', () => {
    const dom = installDom();
    try {
      const { root, page } = createPage(dom, {
        search: { query: 'auth', results: [result()], total: 1 },
      });

      page.mount();

      expect(root.querySelector('.search-filters')).toBeNull();
      const region = query<HTMLElement>(root, '#search-results-region');
      expect(region).not.toBeNull();
      expect(region?.getAttribute('aria-busy')).toBe('false');

      const status = query<HTMLElement>(root, '#search-status');
      expect(status).not.toBeNull();
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.getAttribute('aria-live')).toBe('polite');
      expect(status?.textContent).toBe('1 result');

      expect(root.querySelectorAll('.search-result')).toHaveLength(1);
      expect(query(root, '.search-result-name')?.textContent).toBe('mcp-agent-identity');
    } finally {
      dom.cleanup();
    }
  });

  test('keeps the status outside and before the scrolling result body', () => {
    const dom = installDom();
    try {
      const { root, page } = createPage(dom, {
        search: { query: 'auth', results: [result()], total: 1 },
      });

      page.mount();

      const region = query<HTMLElement>(root, '#search-results-region')!;
      const status = query<HTMLElement>(root, '#search-status')!;
      const body = query<HTMLElement>(root, '.search-results-body')!;

      // The status line must sit above the scroll surface, not inside it, so it
      // stays visible while long result lists scroll.
      expect(body.contains(status)).toBe(false);
      expect(region.firstElementChild).toBe(status);
      expect(status.nextElementSibling).toBe(body);
      expect(body.querySelector('.search-result')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('is idempotent when mounted twice', () => {
    const dom = installDom();
    try {
      const { root, page } = createPage(dom, { search: { results: [result()], total: 1 } });

      page.mount();
      page.mount();

      expect(root.querySelectorAll('#search-status')).toHaveLength(1);
      expect(root.querySelectorAll('.search-result')).toHaveLength(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search page live updates', () => {
  test('keeps the status node identity while results update', () => {
    const dom = installDom();
    try {
      const { store, root, page } = createPage(dom, { search: { query: 'auth' } });
      page.mount();

      const status = query<HTMLElement>(root, '#search-status');
      const region = query<HTMLElement>(root, '#search-results-region');
      expect(status?.textContent).toBe('0 results');

      store.setState({
        search: baseSearch({ query: 'graph', results: [result({ name: 'graph-hit' })], total: 1 }),
      });

      expect(query(root, '#search-status')).toBe(status);
      expect(query(root, '#search-results-region')).toBe(region);
      expect(status?.textContent).toBe('1 result');
      expect(query(root, '.search-result-name')?.textContent).toBe('graph-hit');
    } finally {
      dom.cleanup();
    }
  });
});

describe('search page focus preservation', () => {
  test('restores focus to a result link that survives the update', () => {
    const dom = installDom();
    try {
      const { store, root, page } = createPage(dom, {
        search: { query: 'auth', results: [result()], total: 1 },
      });
      page.mount();

      const original = query<HTMLAnchorElement>(root, '.search-result-link')!;
      original.focus();
      expect(dom.document.activeElement).toBe(original);

      store.setState({
        search: baseSearch({
          query: 'auth',
          results: [result(), result({ id: 'id-2', name: 'second-hit' })],
          total: 2,
        }),
      });

      const replacement = query<HTMLAnchorElement>(root, '.search-result-link')!;
      expect(replacement).not.toBe(original);
      expect(original.isConnected).toBe(false);
      expect(dom.document.activeElement).toBe(replacement);
    } finally {
      dom.cleanup();
    }
  });

  test('never leaves focus on a detached result when it disappears', () => {
    const dom = installDom();
    try {
      const { store, root, page } = createPage(dom, {
        search: { query: 'auth', results: [result()], total: 1 },
      });
      page.mount();

      const original = query<HTMLAnchorElement>(root, '.search-result-link')!;
      original.focus();

      store.setState({
        search: baseSearch({
          query: 'auth',
          results: [result({ id: 'id-2', name: 'different-hit' })],
          total: 1,
        }),
      });

      const region = query<HTMLElement>(root, '#search-results-region')!;
      expect(original.isConnected).toBe(false);
      expect(dom.document.activeElement).toBe(region);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search page handlers', () => {
  test('load more and open-result delegate while tags stay passive data chips', () => {
    const dom = installDom();
    try {
      const spy = createControllerSpy();
      const { root, page, opened } = createPage(dom, {
        controller: spy,
        search: { query: 'auth', results: [result()], total: 45, hasMore: true },
      });
      page.mount();

      const tag = query<HTMLElement>(root, '.search-result-tag')!;
      expect(tag.tagName).toBe('SPAN');
      click(dom, tag);

      const loadMore = query<HTMLButtonElement>(root, '.search-load-more')!;
      expect(loadMore.textContent).toBe('Load more');
      expect(loadMore.querySelector('use')?.getAttribute('href')).toBe(
        '/assets/icons.svg#icon-chevron-down'
      );
      click(dom, loadMore);
      click(dom, query<HTMLElement>(root, '.search-result-link')!);

      expect(spy.calls).toEqual([['loadMore']]);
      expect(opened).toEqual([result()]);
    } finally {
      dom.cleanup();
    }
  });

  test('retry is offered and delegated when the search failed', () => {
    const dom = installDom();
    try {
      const spy = createControllerSpy();
      const { root, page } = createPage(dom, {
        controller: spy,
        search: { query: 'auth', status: 'error', error: 'Search failed: network down' },
      });
      page.mount();

      expect(query(root, '.search-error')?.textContent).toContain('network down');
      click(dom, query<HTMLElement>(root, '.search-retry')!);
      expect(spy.calls).toEqual([['retry']]);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search page async states', () => {
  test('renders loading, success, error and empty states while toggling aria-busy', () => {
    const dom = installDom();
    try {
      const { store, root, page } = createPage(dom, {
        search: { query: 'auth', status: 'loading' },
      });
      page.mount();

      const region = query<HTMLElement>(root, '#search-results-region')!;
      const status = query<HTMLElement>(root, '#search-status')!;
      expect(root.querySelectorAll('.search-skeleton')).toHaveLength(3);
      expect(region.getAttribute('aria-busy')).toBe('true');
      expect(status.getAttribute('aria-busy')).toBe('true');

      store.setState({
        search: baseSearch({ query: 'auth', results: [result()], total: 1, status: 'success' }),
      });
      expect(root.querySelectorAll('.search-skeleton')).toHaveLength(0);
      expect(region.getAttribute('aria-busy')).toBe('false');
      expect(status.getAttribute('aria-busy')).toBe('false');
      expect(status.textContent).toBe('1 result');

      store.setState({
        search: baseSearch({
          query: 'auth',
          status: 'error',
          error: 'Search failed: network down',
        }),
      });
      expect(query(root, '.search-error')?.textContent).toContain('network down');
      expect(region.getAttribute('aria-busy')).toBe('false');

      store.setState({ search: baseSearch({ query: 'auth', status: 'success' }) });
      expect(query(root, '.search-empty')).not.toBeNull();
      expect(status.textContent).toBe('0 results');
    } finally {
      dom.cleanup();
    }
  });
});

describe('search page destroy', () => {
  test('unsubscribes and clears the root, ignoring later updates', () => {
    const dom = installDom();
    try {
      const { store, root, page } = createPage(dom, {
        search: { query: 'auth', results: [result()], total: 1 },
      });
      page.mount();
      expect(root.childElementCount).toBeGreaterThan(0);

      page.destroy();
      expect(root.childElementCount).toBe(0);

      store.setState({
        search: baseSearch({ query: 'graph', results: [result({ name: 'late-hit' })], total: 1 }),
      });
      page.update();

      expect(root.childElementCount).toBe(0);
      expect(root.querySelector('.search-result')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});
