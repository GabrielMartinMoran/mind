import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderSearchView } from '../src/views/search-view.js';

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

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: '',
    filters: { space: '*', tag: '', tier: null, confidence: null },
    semantic: false,
    results: [],
    total: 0,
    hasMore: false,
    status: 'success',
    error: null,
    offset: 0,
    ragEnabled: true,
    currentSpace: null,
    ...overrides,
  };
}

function render(
  dom: DomHarness,
  viewState: Record<string, unknown>,
  handlers: Record<string, unknown> = {}
): HTMLElement {
  const view = renderSearchView(viewState as never, handlers as never) as HTMLElement;
  dom.document.body.appendChild(view);
  return view;
}

function click(dom: DomHarness, target: Element, init: Record<string, unknown> = {}): any {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  } as never);
  target.dispatchEvent(event as never);
  return event;
}

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

describe('search view filter ownership', () => {
  test('does not render a filter bar; the shared shell bar owns filters', () => {
    const dom = installDom();
    try {
      const view = render(dom, state());

      expect(view.tagName).toBe('SECTION');
      expect(view.querySelector('.search-filters')).toBeNull();
      expect(view.querySelector('#search-filter-tag')).toBeNull();
      expect(view.querySelector('#search-filter-tier')).toBeNull();
      expect(view.querySelector('#search-semantic-help')).toBeNull();
      expect(view.querySelectorAll('h1')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search view results', () => {
  test('renders one flat list and hides the per-result space', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          query: 'auth',
          currentSpace: { name: 'projects/mind' },
          filters: { space: 'projects/mind', tag: '', tier: null, confidence: null },
          results: [result(), result({ id: 'id-2', name: 'other' })],
          total: 2,
          status: 'success',
        })
      );

      expect(view.querySelectorAll('.search-group')).toHaveLength(0);
      expect(view.querySelectorAll('.search-result')).toHaveLength(2);
      expect(view.querySelector('.search-result-space')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('card is an anchor with the memory href and renders rank context', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          query: 'auth',
          filters: { space: '*', tag: 'cat:decision', tier: 2, confidence: 'high' },
          semantic: true,
          results: [result()],
          total: 1,
          status: 'success',
        })
      );

      const anchor = query<HTMLAnchorElement>(view, 'article.search-result > a.search-result-link');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe(
        '/spaces/projects%2Fmind?memory=mcp-agent-identity&q=auth&tag=cat%3Adecision&tier=2&confidence=high&semantic=on'
      );

      expect(anchor?.textContent).toContain('mcp-agent-identity');
      expect(anchor?.textContent).not.toContain('projects/mind');
      expect(anchor?.querySelector('.search-result-snippet mark')?.textContent).toBe('auth');
      expect(anchor?.querySelector('.tier-badge')?.textContent).toContain('T2');
      expect(anchor?.querySelector('.confidence-badge')?.textContent).toBe('High confidence');
      expect(anchor?.querySelector('.search-result-methods')?.textContent).toContain('Trigram');
      expect(anchor?.querySelector('.search-result-methods')?.textContent).toContain('Token set');
      expect(anchor?.querySelector('.search-result-score')?.textContent).toContain('0.82');
    } finally {
      dom.cleanup();
    }
  });

  test('result tags are passive data chips outside the anchor and do not open the result', () => {
    const dom = installDom();
    try {
      const opened: unknown[] = [];
      const view = render(
        dom,
        state({ query: 'auth', results: [result()], total: 1, status: 'success' }),
        { onOpenResult: (item: unknown) => opened.push(item) }
      );

      const card = query<HTMLElement>(view, 'article.search-result')!;
      const anchor = query<HTMLAnchorElement>(card, 'a.search-result-link')!;
      const tags = Array.from(card.querySelectorAll<HTMLElement>('.search-result-tag'));

      expect(tags).toHaveLength(2);
      expect(tags.map(tag => tag.tagName)).toEqual(['SPAN', 'SPAN']);
      expect(tags.map(tag => tag.textContent)).toEqual(['#cat:decision', '#type:learning']);
      expect(tags.every(tag => !tag.hasAttribute('data-tag-filter'))).toBe(true);
      expect(anchor.querySelector('.search-result-tag')).toBeNull();
      // One anchor, no nested controls, and no inert button masquerading as an action.
      expect(card.querySelectorAll('button')).toHaveLength(0);
      expect(card.querySelectorAll('a')).toHaveLength(1);

      click(dom, tags[0]!);
      expect(opened).toHaveLength(0);

      click(dom, anchor);
      expect(opened).toEqual([result()]);
    } finally {
      dom.cleanup();
    }
  });

  test('score explains that it is relative to this search for sighted and AT users', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ query: 'auth', results: [result()], total: 1 }));

      const score = query<HTMLElement>(view, '.search-result-score')!;
      expect(score.textContent).toContain('0.82');

      const describedBy = score.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const hint = view.querySelector(`#${describedBy}`);
      expect(hint?.textContent?.toLowerCase()).toContain('relative to this search');
      expect(hint?.hasAttribute('hidden')).toBe(false);
      expect(hint?.getAttribute('aria-hidden')).not.toBe('true');
      expect(score.getAttribute('title')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('modifier and middle clicks on a result card fall through to the browser', () => {
    const dom = installDom();
    try {
      const opened: unknown[] = [];
      const view = render(dom, state({ query: 'auth', results: [result()], total: 1 }), {
        onOpenResult: (item: unknown) => opened.push(item),
      });

      const anchor = query<HTMLAnchorElement>(view, 'a.search-result-link')!;

      const metaClick = click(dom, anchor, { metaKey: true });
      expect(opened).toHaveLength(0);
      expect(metaClick.defaultPrevented).toBe(false);

      const ctrlClick = click(dom, anchor, { ctrlKey: true });
      expect(opened).toHaveLength(0);
      expect(ctrlClick.defaultPrevented).toBe(false);

      const middleClick = click(dom, anchor, { button: 1 });
      expect(opened).toHaveLength(0);
      expect(middleClick.defaultPrevented).toBe(false);

      // A plain primary click still opens the memory through the app handler.
      click(dom, anchor);
      expect(opened).toEqual([result()]);
    } finally {
      dom.cleanup();
    }
  });

  test('passive result tags are not keyboard controls', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ query: 'auth', results: [result()], total: 1 }));

      const tag = query<HTMLElement>(view, '.search-result-tag')!;
      expect(tag.tagName).toBe('SPAN');
      expect(tag.closest('button, a')).toBeNull();
      expect(tag.hasAttribute('tabindex')).toBe(false);
      expect(tag.getAttribute('role')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders the result range and announces it politely', () => {
    const dom = installDom();
    try {
      const page = Array.from({ length: 30 }, (_, index) => result({ id: `id-${index}` }));
      const view = render(dom, state({ query: 'auth', results: page, total: 120, offset: 0 }));

      const status = query<HTMLElement>(view, '.search-status')!;
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toBe('Showing 1–30 of 120 results');

      const shortView = render(dom, state({ query: 'auth', results: [result()], total: 1 }));
      expect(shortView.querySelector('.search-status')?.textContent).toBe('1 result');
    } finally {
      dom.cleanup();
    }
  });

  test('shows three skeleton cards and marks the region busy while loading', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ status: 'loading' }));

      expect(view.querySelectorAll('.search-skeleton')).toHaveLength(3);
      expect(query<HTMLElement>(view, '.search-results-region')?.getAttribute('aria-busy')).toBe(
        'true'
      );
      expect(query<HTMLElement>(view, '.search-status')?.getAttribute('aria-busy')).toBe('true');
    } finally {
      dom.cleanup();
    }
  });

  test('shows guidance without a duplicate clear action when nothing matches', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ query: 'zzz' }));

      expect(query(view, '.search-empty')?.textContent).toContain(
        'No memories match these filters. Try a broader query or clear filters above.'
      );
      expect(view.querySelector('.search-empty-action')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('shows a plain-text error with a retry action', () => {
    const dom = installDom();
    try {
      let retried = 0;
      const view = render(
        dom,
        state({ status: 'error', error: 'Search failed: <b>network down</b>' }),
        { onRetry: () => (retried += 1) }
      );

      const error = query<HTMLElement>(view, '.search-error')!;
      expect(error.textContent).toContain('Search failed: <b>network down</b>');
      expect(error.querySelector('b')).toBeNull();

      click(dom, query<HTMLButtonElement>(view, '.search-retry')!);
      expect(retried).toBe(1);
    } finally {
      dom.cleanup();
    }
  });

  test('load more is available and disabled while a page is loading', () => {
    const dom = installDom();
    try {
      let loaded = 0;
      const page = Array.from({ length: 30 }, (_, index) => result({ id: `id-${index}` }));
      const view = render(
        dom,
        state({ query: 'auth', results: page, total: 45, hasMore: true, status: 'success' }),
        { onLoadMore: () => (loaded += 1) }
      );

      const button = query<HTMLButtonElement>(view, '.search-load-more')!;
      expect(button.disabled).toBe(false);
      click(dom, button);
      expect(loaded).toBe(1);

      dom.document.body.replaceChildren();
      const loadingView = render(
        dom,
        state({ query: 'auth', results: page, total: 45, hasMore: true, status: 'loading' })
      );
      expect(query<HTMLButtonElement>(loadingView, '.search-load-more')?.disabled).toBe(true);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search command icons', () => {
  test('retry and load more keep visible labels with decorative icons', () => {
    const dom = installDom();
    try {
      const retryView = render(
        dom,
        state({ query: 'auth', status: 'error', error: 'Search failed.' }),
        { onRetry: () => {} }
      );
      const retry = query<HTMLButtonElement>(retryView, '.search-retry')!;
      expect(retry.textContent).toBe('Try again');
      expect(retry.querySelector('svg.icon use')?.getAttribute('href')).toBe(
        '/assets/icons.svg#icon-rotate-ccw'
      );
      expect(retry.querySelector('svg.icon')?.getAttribute('aria-hidden')).toBe('true');

      dom.document.body.replaceChildren();
      const page = Array.from({ length: 30 }, (_, index) => result({ id: `id-${index}` }));
      const moreView = render(
        dom,
        state({ query: 'auth', results: page, total: 45, hasMore: true }),
        { onLoadMore: () => {} }
      );
      const loadMore = query<HTMLButtonElement>(moreView, '.search-load-more')!;
      expect(loadMore.textContent).toBe('Load more');
      expect(loadMore.querySelector('svg.icon use')?.getAttribute('href')).toBe(
        '/assets/icons.svg#icon-chevron-down'
      );
      expect(loadMore.querySelector('svg.icon')?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      dom.cleanup();
    }
  });

  test('result cards keep one anchor with a decorative open affordance', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ query: 'auth', results: [result()], total: 1 }));
      const card = query<HTMLElement>(view, 'article.search-result')!;
      const anchor = query<HTMLAnchorElement>(card, 'a.search-result-link')!;

      const open = query<HTMLElement>(anchor, '.search-result-open svg.icon');
      expect(open).not.toBeNull();
      expect(open?.querySelector('use')?.getAttribute('href')).toBe(
        '/assets/icons.svg#icon-chevron-right'
      );
      expect(open?.getAttribute('aria-hidden')).toBe('true');
      expect(open?.getAttribute('focusable')).toBe('false');
      expect(card.querySelectorAll('a')).toHaveLength(1);
      expect(card.querySelectorAll('button')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });
});

describe('search view safety', () => {
  test('highlights query terms without injecting HTML from the query or content', () => {
    const dom = installDom();
    try {
      const payload = '<img src=x onerror="window.__searchPwned=1">';
      const view = render(
        dom,
        state({
          query: payload,
          results: [result({ content: `${payload} auth tokens` })],
          total: 1,
          status: 'success',
        })
      );

      expect(view.querySelector('img')).toBeNull();
      expect((dom.window as any).__searchPwned).toBeUndefined();
      expect(view.querySelector('.search-result-snippet')?.textContent).toContain(payload);
      expect(view.querySelectorAll('.search-result-snippet mark').length).toBeGreaterThan(0);
    } finally {
      dom.cleanup();
    }
  });

  test('card rendering never assigns user content through innerHTML', () => {
    const source = readFileSync(join(import.meta.dir, '../src/views/search-view.js'), 'utf8');
    expect(source).not.toMatch(/\.innerHTML\s*=/);
    expect(source).not.toMatch(/outerHTML/);
  });
});
