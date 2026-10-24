import { describe, expect, test } from 'bun:test';

import { renderMemoryList } from '../src/views/memory-list.js';

import { installDom, type DomHarness } from './helpers/dom';

interface MemoryFixture {
  id?: string;
  space_name?: string;
  name: string;
  tier: number;
  pinned?: boolean;
  tags?: string[];
  changed_at?: string;
}

function memory(overrides: Partial<MemoryFixture> = {}): MemoryFixture {
  return {
    id: 'id-1',
    space_name: 'test',
    name: 'test-memory',
    tier: 2,
    pinned: false,
    tags: [],
    changed_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    space: 'test',
    memories: [],
    total: 0,
    hasMore: false,
    offset: 0,
    filters: { tier: null, tag: '' },
    status: 'success',
    error: null,
    currentMemory: null,
    ...overrides,
  };
}

function render(
  dom: DomHarness,
  viewState: Record<string, unknown>,
  handlers: Record<string, unknown> = {}
): HTMLElement {
  const view = renderMemoryList(viewState as never, handlers as never) as HTMLElement;
  dom.document.body.appendChild(view);
  return view;
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

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

/** Assert one command button carries a decorative sprite icon plus its text. */
function expectCommandIcon(button: HTMLButtonElement, iconName: string, label: string): void {
  const icon = button.querySelector('svg.icon');
  expect(icon).not.toBeNull();
  expect(icon?.querySelector('use')?.getAttribute('href')).toBe(
    `/assets/icons.svg#icon-${iconName}`
  );
  expect(icon?.getAttribute('aria-hidden')).toBe('true');
  expect(icon?.getAttribute('focusable')).toBe('false');
  expect(button.textContent).toBe(label);
}

describe('memory list tier sections', () => {
  test('groups memories into T1/T2/T3 sections with counts', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [
            memory({ id: '1', name: 'hot', tier: 1 }),
            memory({ id: '2', name: 'warm-a', tier: 2 }),
            memory({ id: '3', name: 'warm-b', tier: 2 }),
            memory({ id: '4', name: 'cold', tier: 3 }),
          ],
          total: 4,
        })
      );

      const sections = Array.from(view.querySelectorAll('.memory-tier'));
      expect(sections).toHaveLength(3);

      const t1 = query<HTMLElement>(view, '.memory-tier[data-tier="1"]')!;
      const t2 = query<HTMLElement>(view, '.memory-tier[data-tier="2"]')!;
      const t3 = query<HTMLElement>(view, '.memory-tier[data-tier="3"]')!;

      expect(t1.textContent).toContain('T1');
      expect(t1.textContent).toContain('Hot');
      expect(t1.querySelectorAll('.memory-card')).toHaveLength(1);
      expect(t2.querySelectorAll('.memory-card')).toHaveLength(2);
      expect(t3.querySelectorAll('.memory-card')).toHaveLength(1);

      expect(query<HTMLElement>(t2, '.memory-tier-count')?.textContent).toBe('2');
      expect(
        Array.from(t2.querySelectorAll<HTMLElement>('.memory-card-name')).map(n => n.textContent)
      ).toEqual(['warm-a', 'warm-b']);
    } finally {
      dom.cleanup();
    }
  });

  test('renders an empty message for tiers without memories', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ memories: [memory({ name: 'warm', tier: 2 })], total: 1 }));

      const t1 = query<HTMLElement>(view, '.memory-tier[data-tier="1"]')!;
      expect(query<HTMLElement>(t1, '.memory-tier-empty')?.textContent).toContain('No T1');
      expect(view.querySelectorAll('.memory-card')).toHaveLength(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory card', () => {
  test('is an anchor to the memory URL with tier, name, tags, changed date and pinned state', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [
            memory({
              name: 'test-memory',
              tier: 2,
              tags: ['cat:decision', 'type:learning', 'status:living', 'ref:workflow'],
              pinned: true,
              changed_at: '2026-10-20T10:00:00.000Z',
            }),
          ],
          total: 1,
        })
      );

      const card = query<HTMLElement>(view, '.memory-card')!;
      expect(card.tagName).toBe('ARTICLE');
      expect(card.dataset.memoryName).toBe('test-memory');

      const anchor = query<HTMLAnchorElement>(card, 'a.memory-card-link')!;
      expect(anchor.getAttribute('href')).toBe('/spaces/test?memory=test-memory');
      expect(anchor.textContent).toContain('test-memory');

      const tier = query<HTMLElement>(anchor, '.memory-card-tier.tier-2')!;
      expect(tier.textContent).toBe('T2');
      expect(tier.getAttribute('aria-label')).toBe('T2 — Warm');
      expect(tier.title).toBe('T2 — Warm');
      expect(anchor.firstElementChild).toBe(tier);

      const meta = query<HTMLElement>(anchor, '.memory-card-meta')!;
      expect(anchor.lastElementChild).toBe(meta);
      expect(query<HTMLElement>(meta, '.memory-card-changed')?.textContent).toContain(
        'Oct 20, 2026'
      );
      expect(query<HTMLElement>(card, '.memory-card-pinned')?.textContent).toContain('Pinned');
      expect(query<HTMLElement>(card, '.memory-card-pin')).toBeNull();

      const tags = Array.from(meta.querySelectorAll<HTMLElement>('.memory-card-tag')).map(
        node => node.textContent
      );
      expect(tags).toEqual(['#cat:decision', '#type:learning', '#status:living']);
      expect(query<HTMLElement>(meta, '.memory-card-tag-more')?.textContent).toBe('+1');
    } finally {
      dom.cleanup();
    }
  });

  test('keeps name and tags in separate regions with the date last', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [
            memory({
              name: 'region-check',
              tier: 2,
              tags: ['cat:decision', 'status:living'],
            }),
          ],
          total: 1,
        })
      );

      const anchor = query<HTMLElement>(view, 'a.memory-card-link')!;
      const head = query<HTMLElement>(anchor, '.memory-card-head')!;
      const meta = query<HTMLElement>(anchor, '.memory-card-meta')!;

      expect(anchor.children[0]?.className).toContain('memory-card-tier');
      expect(anchor.children[1]).toBe(head);
      expect(anchor.children[2]).toBe(meta);
      expect(query<HTMLElement>(head, '.memory-card-name')?.textContent).toBe('region-check');
      expect(head.querySelector('.memory-card-tags')).toBeNull();

      const metaChildren = Array.from(meta.children).map(node => node.className);
      expect(metaChildren[0]).toContain('memory-card-tags');
      expect(metaChildren[metaChildren.length - 1]).toContain('memory-card-changed');
    } finally {
      dom.cleanup();
    }
  });

  test('has exactly one control: the card anchor, with no nested button or second link', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [
            memory({
              name: 'single-control',
              tier: 2,
              pinned: true,
              tags: ['cat:decision'],
            }),
          ],
          total: 1,
        })
      );

      const card = query<HTMLElement>(view, '.memory-card')!;
      const anchors = Array.from(card.querySelectorAll('a'));
      const buttons = Array.from(card.querySelectorAll('button'));

      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.classList.contains('memory-card-link')).toBe(true);
      expect(buttons).toHaveLength(0);

      // No other interactive control (button, link, input, select, textarea) hides in the card.
      const controls = card.querySelectorAll('button, a, input, select, textarea, [tabindex]');
      expect(Array.from(controls)).toEqual([anchors[0]!]);
    } finally {
      dom.cleanup();
    }
  });

  test('keeps the whole card clickable without any pin control', () => {
    const dom = installDom();
    try {
      const calls: { open: string[] } = { open: [] };
      const view = render(
        dom,
        state({ memories: [memory({ name: 'pinnable', tier: 2, pinned: false })], total: 1 }),
        { onOpen: (item: MemoryFixture) => calls.open.push(item.name) }
      );

      const card = query<HTMLElement>(view, '.memory-card')!;
      const anchor = query<HTMLAnchorElement>(card, 'a.memory-card-link')!;

      expect(card.querySelectorAll('button')).toHaveLength(0);
      expect(card.querySelector('.memory-card-pin')).toBeNull();

      click(dom, anchor);

      expect(calls.open).toEqual(['pinnable']);
    } finally {
      dom.cleanup();
    }
  });

  test('pinned is a passive, non-interactive indicator', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({ memories: [memory({ name: 'pinned-one', tier: 1, pinned: true })], total: 1 })
      );

      const pinned = query<HTMLElement>(view, '.memory-card-pinned')!;
      expect(pinned.tagName).toBe('SPAN');
      expect(pinned.textContent).toBe('Pinned');
      expect(pinned.closest('button')).toBeNull();
      expect(view.querySelector('[aria-pressed]')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('marks the selected memory with aria-current', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [memory({ name: 'selected', tier: 2 }), memory({ name: 'other', tier: 2 })],
          total: 2,
          currentMemory: { name: 'selected' },
        })
      );

      const selected = query<HTMLAnchorElement>(
        view,
        '.memory-card[data-memory-name="selected"] a.memory-card-link'
      )!;
      const other = query<HTMLAnchorElement>(
        view,
        '.memory-card[data-memory-name="other"] a.memory-card-link'
      )!;

      expect(selected.getAttribute('aria-current')).toBe('true');
      expect(other.getAttribute('aria-current')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory filters', () => {
  test('the view no longer owns a filter bar', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ filters: { tiers: [1, 2, 3], tag: '' } }));
      expect(view.querySelector('.memory-filters')).toBeNull();
      expect(dom.document.getElementById('memory-filter-tier')).toBeNull();
      expect(dom.document.getElementById('memory-filter-tag')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory pagination', () => {
  test('shows the shown/total range and a show-more control', () => {
    const dom = installDom();
    try {
      let more = 0;
      const view = render(
        dom,
        state({
          memories: [memory({ name: 'a', tier: 2 }), memory({ name: 'b', tier: 2 })],
          total: 250,
          hasMore: true,
          status: 'success',
        }),
        { onLoadMore: () => (more += 1) }
      );

      const status = query<HTMLElement>(view, '#memory-status')!;
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toBe('Showing 2 of 250 memories');

      const showMore = query<HTMLButtonElement>(view, '#memory-show-more')!;
      expect(showMore.disabled).toBe(false);
      click(dom, showMore);
      expect(more).toBe(1);
    } finally {
      dom.cleanup();
    }
  });

  test('disables show more while loading', () => {
    const dom = installDom();
    try {
      const loading = render(
        dom,
        state({
          memories: [memory({ name: 'a', tier: 2 })],
          total: 10,
          hasMore: true,
          status: 'loading',
        })
      );
      expect(query<HTMLButtonElement>(loading, '#memory-show-more')?.disabled).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('hides show more when no more pages exist', () => {
    const dom = installDom();
    try {
      const done = render(
        dom,
        state({
          memories: [memory({ name: 'a', tier: 2 })],
          total: 1,
          hasMore: false,
          status: 'success',
        })
      );
      expect(query(done, '#memory-show-more')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory async and empty states', () => {
  test('shows skeletons and aria-busy while loading', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ status: 'loading' }));

      expect(view.getAttribute('aria-busy')).toBe('true');
      expect(view.querySelectorAll('.memory-skeleton')).toHaveLength(3);
      expect(query<HTMLElement>(view, '.memory-skeleton-list')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
      expect(query<HTMLElement>(view, '#memory-status')?.textContent).toBe('Loading memories…');
    } finally {
      dom.cleanup();
    }
  });

  test('empty space shows guidance and a create action', () => {
    const dom = installDom();
    try {
      let created = 0;
      const view = render(dom, state(), { onCreate: () => (created += 1) });

      expect(view.textContent).toContain('This space has no memories yet');
      click(dom, query<HTMLButtonElement>(view, '#memory-empty-create')!);
      expect(created).toBe(1);
    } finally {
      dom.cleanup();
    }
  });

  test('no filter matches explains how to broaden without a duplicate clear action', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ filters: { tiers: [1], tag: 'cat:decision' } }));

      expect(view.textContent).toContain('No memories match these filters');
      expect(view.querySelector('#memory-no-match-clear')).toBeNull();
      expect(view.querySelector('.memory-empty-action')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('load failure shows the error and retries', () => {
    const dom = installDom();
    try {
      let retries = 0;
      const view = render(dom, state({ status: 'error', error: 'The server is unavailable.' }), {
        onRetry: () => (retries += 1),
      });

      const alert = query<HTMLElement>(view, '.memory-error')!;
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain('The server is unavailable.');

      click(dom, query<HTMLButtonElement>(view, '#memory-retry')!);
      expect(retries).toBe(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory list command icons', () => {
  test('Add memory, retry and show more keep visible labels with decorative icons', () => {
    const dom = installDom();
    try {
      const emptyView = render(dom, state(), { onCreate: () => {} });
      expectCommandIcon(
        query<HTMLButtonElement>(emptyView, '#memory-empty-create')!,
        'file-plus',
        'Add a memory'
      );

      dom.document.body.replaceChildren();
      const errorView = render(dom, state({ status: 'error', error: 'Offline.' }), {
        onRetry: () => {},
      });
      expectCommandIcon(
        query<HTMLButtonElement>(errorView, '#memory-retry')!,
        'rotate-ccw',
        'Try again'
      );

      dom.document.body.replaceChildren();
      const moreView = render(
        dom,
        state({ memories: [memory({ name: 'a', tier: 2 })], total: 2, hasMore: true }),
        { onLoadMore: () => {} }
      );
      expectCommandIcon(
        query<HTMLButtonElement>(moreView, '#memory-show-more')!,
        'chevron-down',
        'Show more'
      );
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory list safety', () => {
  test('renders user content as text and never as markup', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          memories: [
            memory({
              name: '<img src=x onerror="alert(1)">',
              tier: 2,
              tags: ['<script>alert(2)</script>'],
            }),
          ],
          total: 1,
        })
      );

      expect(view.querySelector('img')).toBeNull();
      expect(view.querySelector('script')).toBeNull();

      const name = query<HTMLElement>(view, '.memory-card-name')!;
      const tag = query<HTMLElement>(view, '.memory-card-tag')!;
      expect(name.textContent).toBe('<img src=x onerror="alert(1)">');
      expect(name.children).toHaveLength(0);
      expect(tag.textContent).toBe('#<script>alert(2)</script>');
      expect(tag.children).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });
});
