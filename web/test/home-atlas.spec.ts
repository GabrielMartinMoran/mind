import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  bindSpaceLinks,
  createSpaceCard,
  renderHomeSpaces,
  renderSpaceList,
} from '../src/views/space-list.js';

import { installDom, type DomHarness } from './helpers/dom';

interface SpaceFixture {
  name: string;
  description?: string;
  memory_count?: number;
  tier_counts?: { t1: number; t2: number; t3: number };
  tags?: string[];
  hidden?: boolean;
}

const MIND_SPACE: SpaceFixture = {
  name: 'projects/mind',
  description: 'Long-term memory engine',
  memory_count: 5,
  tier_counts: { t1: 2, t2: 1, t3: 2 },
  tags: ['type:project', 'cat:decision', 'status:living', 'extra'],
};

const TIERED_SPACE: SpaceFixture = {
  name: 'projects/mind',
  description: 'Long-term memory engine',
  memory_count: 411,
  tier_counts: { t1: 25, t2: 80, t3: 306 },
  tags: ['type:project', 'cat:decision', 'status:living', 'extra'],
};

const EMPTY_SPACE: SpaceFixture = {
  name: 'projects/empty',
  description: 'Nothing collected yet',
  memory_count: 0,
  tier_counts: { t1: 0, t2: 0, t3: 0 },
  tags: [],
};

const HIDDEN_SPACE: SpaceFixture = {
  name: 'sessions/mind',
  description: 'Session checkpoints',
  memory_count: 2,
  tags: ['type:session'],
  hidden: true,
};

function click(dom: DomHarness, target: EventTarget, init: Record<string, unknown> = {}): any {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ...init,
  } as any);
  target.dispatchEvent(event as any);
  return event;
}

function descendants<T extends Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as unknown as T[];
}

describe('space card', () => {
  test('is an anchor with href, name, description, count, tags and hidden badge', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ ...MIND_SPACE });

      expect(card.tagName).toBe('A');
      expect(card.getAttribute('href')).toBe('/spaces/projects%2Fmind');
      expect(card.classList.contains('space-card')).toBe(true);
      expect(card.hasAttribute('data-space-link')).toBe(true);
      expect(card.getAttribute('data-space-name')).toBe('projects/mind');
      expect(card.textContent).toContain('projects/mind');
      expect(card.querySelector('.space-card-description')?.textContent).toBe(
        'Long-term memory engine'
      );
      expect(card.querySelector('.space-card-count')?.textContent).toBe('5 memories');

      const tags = descendants<HTMLElement>(card, '.space-card-tag').map(tag => tag.textContent);
      expect(tags).toEqual(['#type:project', '#cat:decision', '#status:living']);
      expect(card.querySelector('.space-card-tag-more')?.textContent).toBe('+1');
      expect(card.querySelector('.space-card-tags')?.getAttribute('title')).toBe(
        '#type:project #cat:decision #status:living #extra'
      );
      expect(card.querySelector('.space-card-badge')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('shows a singular count and a hidden badge for hidden spaces', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ ...HIDDEN_SPACE });

      expect(card.querySelector('.space-card-count')?.textContent).toBe('2 memories');
      expect(card.querySelector('.space-card-badge')?.textContent).toBe('Hidden');
    } finally {
      dom.cleanup();
    }
  });

  test('marks the current space with aria-current="page" only', () => {
    const dom = installDom();
    try {
      const current = createSpaceCard(MIND_SPACE, { currentSpace: { name: 'projects/mind' } });
      const other = createSpaceCard(MIND_SPACE, { currentSpace: { name: 'other' } });
      const none = createSpaceCard(MIND_SPACE);

      expect(current.getAttribute('aria-current')).toBe('page');
      expect(other.getAttribute('aria-current')).toBeNull();
      expect(none.getAttribute('aria-current')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders a proportional T1/T2/T3 spectrum and per-tier counts', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ ...TIERED_SPACE });

      const spectrum = card.querySelector('.space-tier-spectrum') as HTMLElement;
      expect(spectrum).not.toBeNull();
      expect(spectrum.getAttribute('aria-hidden')).toBe('true');

      const segments = descendants<HTMLElement>(card, '.space-tier-segment');
      expect(segments).toHaveLength(3);
      expect(segments.map(segment => segment.classList.contains('t1'))).toEqual([
        true,
        false,
        false,
      ]);
      expect(segments.map(segment => segment.classList.contains('t2'))).toEqual([
        false,
        true,
        false,
      ]);
      expect(segments.map(segment => segment.classList.contains('t3'))).toEqual([
        false,
        false,
        true,
      ]);
      expect(segments.map(segment => segment.style.flexGrow)).toEqual(['25', '80', '306']);

      const counts = descendants<HTMLElement>(card, '.space-tier-count').map(
        count => count.textContent
      );
      expect(counts).toEqual(['T1 25', 'T2 80', 'T3 306']);

      expect(card.querySelector('.space-card-count')?.textContent).toBe('411 memories');
    } finally {
      dom.cleanup();
    }
  });

  test('renders passive tier chips with a distinct label and emphasized count', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ ...TIERED_SPACE });
      const chips = descendants<HTMLElement>(card, '.space-tier-count');

      expect(chips.map(chip => chip.textContent)).toEqual(['T1 25', 'T2 80', 'T3 306']);
      expect(chips.map(chip => chip.querySelector('.space-tier-label')?.textContent)).toEqual([
        'T1',
        'T2',
        'T3',
      ]);
      expect(chips.map(chip => chip.querySelector('.space-tier-value')?.textContent)).toEqual([
        '25',
        '80',
        '306',
      ]);

      for (const chip of chips) {
        expect(chip.tagName).toBe('SPAN');
        expect(chip.hasAttribute('role')).toBe(false);
        expect(chip.hasAttribute('tabindex')).toBe(false);
      }
      expect(card.querySelector('.space-tier-dot')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('keeps label and count as separate, unmerged text with exact accessible text', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({
        name: 'projects/compact',
        memory_count: 10,
        tier_counts: { t1: 1, t2: 7, t3: 2 },
      });
      const chips = descendants<HTMLElement>(card, '.space-tier-count');

      expect(chips.map(chip => chip.textContent)).toEqual(['T1 1', 'T2 7', 'T3 2']);
      expect(chips.map(chip => chip.className)).toEqual([
        'space-tier-count t1',
        'space-tier-count t2',
        'space-tier-count t3',
      ]);

      for (const chip of chips) {
        const label = chip.querySelector('.space-tier-label');
        const value = chip.querySelector('.space-tier-value');
        const spacing = label?.nextSibling;

        expect(label).not.toBeNull();
        expect(value).not.toBeNull();
        expect(spacing?.nodeType).toBe(3);
        expect(spacing?.textContent?.trim()).toBe('');
        expect(spacing?.textContent).toHaveLength(1);
        expect(value?.previousSibling).toBe(spacing);
        expect(chip.querySelector('button, a, [role], [tabindex]')).toBeNull();
      }
    } finally {
      dom.cleanup();
    }
  });

  test('mutes zero-count chips without hiding their label or number', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({
        name: 'projects/sparse',
        memory_count: 3,
        tier_counts: { t1: 0, t2: 3, t3: 0 },
      });
      const chips = descendants<HTMLElement>(card, '.space-tier-count');

      expect(chips.map(chip => chip.classList.contains('is-zero'))).toEqual([true, false, true]);
      expect(chips.map(chip => chip.textContent)).toEqual(['T1 0', 'T2 3', 'T3 0']);
    } finally {
      dom.cleanup();
    }
  });

  test('renders an empty state instead of three zero counts for a space with no memories', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ ...EMPTY_SPACE });

      expect(card.querySelectorAll('.space-tier-segment')).toHaveLength(0);
      expect(card.querySelector('.space-tier-counts')).toBeNull();
      expect(card.querySelector('.space-tier-empty')?.textContent).toBe('No memories yet');
      expect(card.querySelector('.space-card-count')?.textContent).toBe('0 memories');
      expect(card.tagName).toBe('A');
    } finally {
      dom.cleanup();
    }
  });

  test('defaults missing tier counts to zero without inventing values', () => {
    const dom = installDom();
    try {
      const card = createSpaceCard({ name: 'legacy', memory_count: 3 });

      const segments = descendants<HTMLElement>(card, '.space-tier-segment');
      expect(segments).toHaveLength(3);
      expect(segments.map(segment => segment.style.flexGrow)).toEqual(['0', '0', '0']);
      expect(
        descendants<HTMLElement>(card, '.space-tier-count').map(count => count.textContent)
      ).toEqual(['T1 0', 'T2 0', 'T3 0']);
    } finally {
      dom.cleanup();
    }
  });
});

describe('sidebar space list', () => {
  test('returns list items with real anchors and marks the active space', () => {
    const dom = installDom();
    try {
      const items = renderSpaceList([MIND_SPACE, HIDDEN_SPACE], {
        currentSpace: { name: 'projects/mind' },
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.tagName).toBe('LI');

      const link = items[0]?.querySelector('a') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute('href')).toBe('/spaces/projects%2Fmind');
      expect(link.getAttribute('aria-current')).toBe('page');
      expect(link.classList.contains('is-active')).toBe(true);
      expect(link.textContent).toContain('projects/mind');
    } finally {
      dom.cleanup();
    }
  });

  test('includes hidden spaces when includeHidden is true and leaves them out otherwise', () => {
    const dom = installDom();
    try {
      const visibleOnly = renderSpaceList([MIND_SPACE, HIDDEN_SPACE], {});
      const withHidden = renderSpaceList([MIND_SPACE, HIDDEN_SPACE], { includeHidden: true });

      expect(visibleOnly).toHaveLength(1);
      expect(withHidden).toHaveLength(2);

      const hiddenLink = withHidden[1]?.querySelector('a') as HTMLAnchorElement;
      expect(hiddenLink.classList.contains('space-hidden')).toBe(true);
      expect(hiddenLink.textContent).toContain('sessions/mind');
      expect(hiddenLink.querySelector('.space-hidden-badge')?.textContent).toBe('Hidden');
      expect(hiddenLink.getAttribute('aria-current')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('home grid', () => {
  test('renders one list item per supplied space with a real anchor card', () => {
    const dom = installDom();
    try {
      const items = renderHomeSpaces([MIND_SPACE, EMPTY_SPACE]);

      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.tagName).toBe('LI');
        expect(item.classList.contains('home-atlas-item')).toBe(true);
        expect(item.querySelector('a.space-card')).not.toBeNull();
      }
      expect(items[0]?.querySelector('a')?.getAttribute('href')).toBe('/spaces/projects%2Fmind');
    } finally {
      dom.cleanup();
    }
  });

  test('marks the current space in the grid when one is supplied', () => {
    const dom = installDom();
    try {
      const items = renderHomeSpaces([MIND_SPACE], {
        currentSpace: { name: 'projects/mind' },
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.querySelector('a')?.getAttribute('aria-current')).toBe('page');
    } finally {
      dom.cleanup();
    }
  });

  test('returns no items when there are no spaces to render', () => {
    const dom = installDom();
    try {
      expect(renderHomeSpaces([])).toEqual([]);
    } finally {
      dom.cleanup();
    }
  });

  test('uses four equal columns from 1360px and auto-fit below it', () => {
    const shellCss = readFileSync(join(import.meta.dir, '../styles/components/shell.css'), 'utf8');

    // Below 1360px the grid keeps adapting its column count to the width, which
    // also leaves a 320px viewport at the single 220px column.
    const base = /\.home-atlas-grid\s*\{([^}]*)\}/.exec(shellCss)?.[1] ?? '';
    expect(base).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(220px,\s*1fr\)\)/);

    const wide = /@media\s*\(min-width:\s*1360px\)\s*\{([\s\S]*?)\n\}/.exec(shellCss)?.[1] ?? '';
    expect(wide, 'min-width: 1360px block should exist').not.toBe('');
    expect(wide).toMatch(
      /\.home-atlas-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/
    );

    // Four columns span the available width; no fixed max-width reopens a gutter.
    const wideGrid = /\.home-atlas-grid\s*\{([^}]*)\}/.exec(wide)?.[1] ?? '';
    expect(wideGrid).not.toMatch(/max-width/);
  });
});

describe('space link binder', () => {
  function createBinderHarness(): {
    dom: DomHarness;
    root: HTMLElement;
    link: HTMLAnchorElement;
    selected: string[];
    controller: { destroy: () => void };
  } {
    const dom = installDom();
    const root = dom.document.createElement('div');
    root.innerHTML = `
      <a class="space-card" data-space-link data-space-name="projects/mind" href="/spaces/projects%2Fmind">
        <span class="space-card-name">projects/mind</span>
      </a>
    `;
    dom.document.body.appendChild(root);

    const link = root.querySelector('a') as HTMLAnchorElement;
    const selected: string[] = [];
    const controller = bindSpaceLinks(root, { onSelect: name => selected.push(name) });

    return { dom, root, link, selected, controller };
  }

  test('plain primary clicks prevent default and call onSelect with the space name', () => {
    const harness = createBinderHarness();
    try {
      const name = harness.link.querySelector('.space-card-name') as HTMLElement;
      const event = click(harness.dom, name);

      expect(event.defaultPrevented).toBe(true);
      expect(harness.selected).toEqual(['projects/mind']);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('modifier and middle clicks fall through to the browser', () => {
    const harness = createBinderHarness();
    try {
      for (const init of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const event = click(harness.dom, harness.link, init);
        expect(event.defaultPrevented).toBe(false);
      }

      expect(harness.selected).toEqual([]);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('destroy removes the delegated listener', () => {
    const harness = createBinderHarness();
    try {
      harness.controller.destroy();
      harness.controller.destroy();

      const event = click(harness.dom, harness.link);
      expect(event.defaultPrevented).toBe(false);
      expect(harness.selected).toEqual([]);
    } finally {
      harness.dom.cleanup();
    }
  });
});
