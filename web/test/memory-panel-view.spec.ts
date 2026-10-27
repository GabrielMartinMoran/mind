import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createMemoryPanel } from '../src/views/memory-panel.js';

import { installDom, type DomHarness } from './helpers/dom';

const indexHtmlPath = join(import.meta.dir, '../public/index.html');
const panelCssPath = join(import.meta.dir, '../styles/components/memory-panel.css');

interface MemoryFixture {
  name: string;
  space_name: string;
  content: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  changed_at: string;
}

function memory(overrides: Partial<MemoryFixture> = {}): MemoryFixture {
  return {
    name: 'test-memory',
    space_name: 'test',
    content: '# Title\n\nBody',
    tier: 2,
    pinned: false,
    tags: [],
    changed_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

interface PanelFixture {
  dom: DomHarness;
  dialog: HTMLDialogElement;
  trigger: HTMLButtonElement;
  panel: ReturnType<typeof createMemoryPanel>;
}

function setup(handlers: Record<string, (...args: any[]) => void> = {}): PanelFixture {
  const dom = installDom();
  const html = readFileSync(indexHtmlPath, 'utf8');
  const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');
  const source = parsed.getElementById('memory-panel');
  if (!source) throw new Error('memory-panel markup missing from index.html');

  const dialog = dom.document.importNode(source as never, true) as unknown as HTMLDialogElement;
  dom.document.body.replaceChildren(dialog);

  const trigger = dom.document.createElement('button');
  trigger.id = 'trigger';
  trigger.textContent = 'Open memory';
  dom.document.body.appendChild(trigger);
  trigger.focus();

  const panel = createMemoryPanel({
    dialog,
    document: dom.document,
    handlers: handlers as never,
  });

  return { dom, dialog, trigger, panel };
}

function stubMarked(dom: DomHarness, parse: (markdown: string) => string): void {
  Reflect.set(dom.window, 'marked', { parse });
}

function click(dom: DomHarness, target: Element): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    } as never) as never
  );
}

function pressEscape(dom: DomHarness): void {
  dom.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    } as never) as never
  );
}

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

function iconHref(element: Element | null): string | null {
  return element?.querySelector('svg.icon use')?.getAttribute('href') ?? null;
}

function expectDecorativeIcon(element: Element | null, name: string): void {
  expect(element, `control for icon-${name}`).not.toBeNull();
  const icon = element!.querySelector('svg.icon');
  expect(icon, `svg.icon on control for icon-${name}`).not.toBeNull();
  expect(icon!.getAttribute('aria-hidden')).toBe('true');
  expect(icon!.getAttribute('focusable')).toBe('false');
  expect(iconHref(element)).toBe(`/assets/icons.svg#icon-${name}`);
}

describe('memory panel markup', () => {
  test('index.html declares a closed dialog with an accessible name', () => {
    const dom = installDom();
    try {
      const html = readFileSync(indexHtmlPath, 'utf8');
      const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');
      const panel = parsed.getElementById('memory-panel');

      expect(panel?.tagName).toBe('DIALOG');
      expect(panel?.hasAttribute('open')).toBe(false);
      expect(panel?.getAttribute('aria-labelledby')).toBe('mem-title');
      expect(panel?.getAttribute('aria-modal')).toBe('true');
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory panel dialog behavior', () => {
  test('opens as a labelled modal dialog and moves focus inside', () => {
    const { dom, dialog, panel } = setup();
    try {
      let shown = 0;
      const original = dialog.showModal.bind(dialog);
      (dialog as any).showModal = () => {
        shown += 1;
        original();
      };

      panel.open(memory(), {});

      expect(shown).toBe(1);
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBe('mem-title');
      expect(query<HTMLElement>(dialog, '#mem-title')?.textContent).toBe('test-memory');
      expect(dialog.contains(dom.document.activeElement)).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('falls back to the open attribute when showModal is unavailable', () => {
    const { dom, dialog, panel } = setup();
    try {
      (dialog as any).showModal = undefined;

      panel.open(memory(), {});

      expect(dialog.hasAttribute('open')).toBe(true);
      expect(panel.isOpen()).toBe(true);
      expect(dialog.contains(dom.document.activeElement)).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('closing restores focus to the trigger', () => {
    const { dom, dialog, trigger, panel } = setup();
    try {
      panel.open(memory(), { trigger });
      trigger.blur();
      expect(dom.document.activeElement).not.toBe(trigger);

      panel.close();

      expect(dialog.open).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
      expect(panel.isOpen()).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('Escape closes the panel and returns focus to the trigger', () => {
    const { dom, dialog, trigger, panel } = setup();
    try {
      panel.open(memory(), { trigger });

      pressEscape(dom);

      expect(dialog.open).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.cleanup();
    }
  });

  test('clicking the backdrop closes the panel', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.open(memory(), {});

      click(dom, dialog);

      expect(dialog.open).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('close buttons request close through the handler when provided', () => {
    const calls: string[] = [];
    const { dom, dialog, panel } = setup({
      onClose: () => calls.push('close'),
    });
    try {
      panel.open(memory(), {});

      click(dom, query<HTMLElement>(dialog, '#btn-mem-close-inline')!);

      expect(calls).toEqual(['close']);
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory panel content', () => {
  test('renders sanitized markdown and removes scripts and unsafe links', () => {
    const { dom, dialog, panel } = setup();
    try {
      stubMarked(
        dom,
        () =>
          '<h1>Title</h1><ul><li>one</li></ul><pre><code>x</code></pre>' +
          '<script>alert(1)</script><a href="javascript:alert(1)">bad</a>'
      );

      panel.open(memory({ content: '# Title' }), {});

      const content = query<HTMLElement>(dialog, '#mem-content')!;
      expect(content.classList.contains('hidden')).toBe(false);
      expect(query<HTMLElement>(content, 'h1')?.textContent).toBe('Title');
      expect(content.querySelector('ul li')?.textContent).toBe('one');
      expect(content.querySelector('pre code')?.textContent).toBe('x');
      expect(content.querySelector('script')).toBeNull();

      const link = query<HTMLAnchorElement>(content, 'a')!;
      expect(link.textContent).toBe('bad');
      expect(link.hasAttribute('href')).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('pretty-prints valid JSON with colored token classes and no innerHTML', () => {
    const { dom, dialog, panel } = setup();
    try {
      const raw =
        '{"name":"<img src=x onerror=alert(1)>","count":3,"ok":true,"nothing":null,"items":[1,"two"]}';

      panel.open(memory({ content: raw }), {});

      const content = query<HTMLElement>(dialog, '#mem-content')!;
      const pre = query<HTMLPreElement>(content, 'pre.json-viewer')!;
      expect(pre).not.toBeNull();
      expect(pre.textContent).toContain('\n  "name": ');
      expect(pre.textContent).toContain('\n  "items": [');
      expect(pre.textContent).toContain('\n    1,');

      // Keys and every value primitive get a distinct class.
      expect(pre.querySelector('.json-key')?.textContent).toBe('"name"');
      expect(pre.querySelector('.json-string')?.textContent).toContain('<img src=x');
      expect(pre.querySelector('.json-number')?.textContent).toBe('3');
      expect(pre.querySelector('.json-boolean')?.textContent).toBe('true');
      expect(pre.querySelector('.json-null')?.textContent).toBe('null');

      // User data is text, never live nodes.
      expect(pre.querySelector('img')).toBeNull();
      expect(pre.querySelector('script')).toBeNull();
      expect(pre.textContent).toContain('<img src=x onerror=alert(1)>');

      // The rendered text is the whole pretty document and stays selectable.
      expect(pre.textContent).toBe(JSON.stringify(JSON.parse(raw), null, 2));
    } finally {
      dom.cleanup();
    }
  });

  test('invalid JSON falls back to the markdown/text renderer', () => {
    const { dom, dialog, panel } = setup();
    try {
      const raw = '{"broken": }';

      panel.open(memory({ content: raw }), {});

      const content = query<HTMLElement>(dialog, '#mem-content')!;
      expect(content.querySelector('pre.json-viewer')).toBeNull();
      expect(content.textContent).toBe(raw);
    } finally {
      dom.cleanup();
    }
  });

  test('non-JSON content still renders markdown', () => {
    const { dom, dialog, panel } = setup();
    try {
      stubMarked(dom, () => '<h1>Title</h1>');

      panel.open(memory({ content: '# Title' }), {});

      const content = query<HTMLElement>(dialog, '#mem-content')!;
      expect(content.querySelector('pre.json-viewer')).toBeNull();
      expect(content.querySelector('h1')?.textContent).toBe('Title');
    } finally {
      dom.cleanup();
    }
  });

  test('renders raw content as text when marked is unavailable', () => {
    const { dom, dialog, panel } = setup();
    try {
      Reflect.deleteProperty(dom.window, 'marked');
      const raw = '<h1>literal</h1> & <script>alert(1)</script>';

      panel.open(memory({ content: raw }), {});

      const content = query<HTMLElement>(dialog, '#mem-content')!;
      expect(content.querySelector('h1')).toBeNull();
      expect(content.querySelector('script')).toBeNull();
      expect(content.textContent).toBe(raw);
    } finally {
      dom.cleanup();
    }
  });

  test('shows name, tier badge text, tags, pinned state and changed date', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.open(
        memory({
          tier: 2,
          pinned: true,
          tags: ['cat:decision', 'status:living'],
          changed_at: '2026-10-20T10:00:00.000Z',
        }),
        {}
      );

      expect(query<HTMLElement>(dialog, '#mem-title')?.textContent).toBe('test-memory');

      const badge = query<HTMLElement>(dialog, '#mem-tier-badge')!;
      expect(badge.textContent).toBe('T2');
      expect(badge.title).toContain('T2');

      const tags = Array.from(
        dialog.querySelectorAll<HTMLElement>('#mem-tags-row [data-action="remove-tag"]')
      ).map(node => node.textContent);
      expect(tags).toEqual(['#cat:decision', '#status:living']);
      expect(query<HTMLElement>(dialog, '#mem-tags-row [data-action="add-tag"]')).not.toBeNull();

      expect(query<HTMLElement>(dialog, '#mem-pinned')?.classList.contains('hidden')).toBe(false);
      expect(query<HTMLElement>(dialog, '#mem-changed')?.textContent).toContain('Oct 20, 2026');

      const pin = query<HTMLButtonElement>(dialog, '#btn-mem-pin')!;
      expect(pin.getAttribute('aria-pressed')).toBe('true');
      expect(pin.textContent).toContain('Unpin');
    } finally {
      dom.cleanup();
    }
  });
});

describe('JSON viewer layout contract', () => {
  test('wraps long keys and strings without a horizontal scrollbar', () => {
    const css = readFileSync(panelCssPath, 'utf8');
    const block = /#mem-content \.json-viewer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(block, '.json-viewer rule should exist').not.toBe('');
    expect(block).toMatch(/white-space:\s*pre-wrap/);
    expect(block).toMatch(/overflow-wrap:\s*anywhere/);
    expect(block).toMatch(/word-break:\s*break-word/);
    expect(block).toMatch(/overflow-x:\s*hidden/);
    expect(block).toMatch(/overflow-y:\s*auto/);
    // Two-space indentation stays visible because the whitespace mode preserves it.
    expect(block).toMatch(/tab-size:\s*2/);
  });
});

describe('memory panel async and edit states', () => {
  test('loading shows a static skeleton and marks the dialog busy', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.setLoading();

      expect(dialog.getAttribute('aria-busy')).toBe('true');
      const state = query<HTMLElement>(dialog, '#mem-state')!;
      expect(state.classList.contains('hidden')).toBe(false);
      expect(state.querySelector('.mem-skeleton')).not.toBeNull();
      expect(query<HTMLElement>(dialog, '#mem-content')?.classList.contains('hidden')).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('error shows a message and retries through the handler', () => {
    const calls: number[] = [];
    const { dom, dialog, panel } = setup({ onRetry: () => calls.push(1) });
    try {
      panel.setError('The memory could not be loaded.');

      expect(dialog.getAttribute('aria-busy')).toBe('false');
      const state = query<HTMLElement>(dialog, '#mem-state')!;
      expect(state.getAttribute('role')).toBe('alert');
      expect(state.textContent).toContain('The memory could not be loaded.');

      click(dom, query<HTMLElement>(state, '[data-action="retry"]')!);
      expect(calls).toEqual([1]);
    } finally {
      dom.cleanup();
    }
  });

  test('edit mode shows the textarea with save and cancel handlers', () => {
    const saved: string[] = [];
    let cancelled = 0;
    const { dom, dialog, panel } = setup({
      onSave: (content: string) => saved.push(content),
      onCancelEdit: () => {
        cancelled += 1;
      },
    });
    try {
      panel.open(memory({ content: 'original' }), {});

      panel.setEditMode(true);

      const area = query<HTMLElement>(dialog, '#mem-edit-area')!;
      const input = query<HTMLTextAreaElement>(dialog, '#mem-edit-input')!;
      expect(area.classList.contains('hidden')).toBe(false);
      expect(input.value).toBe('original');
      expect(dom.document.activeElement).toBe(input);

      input.value = 'updated';
      click(dom, query<HTMLElement>(dialog, '#btn-mem-save')!);
      expect(saved).toEqual(['updated']);

      click(dom, query<HTMLElement>(dialog, '#btn-mem-cancel-edit')!);
      expect(cancelled).toBe(1);
      expect(area.classList.contains('hidden')).toBe(true);
      expect(query<HTMLElement>(dialog, '#mem-content')?.classList.contains('hidden')).toBe(false);
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory panel action dispatch', () => {
  test('action buttons call the matching handlers', () => {
    const calls: string[] = [];
    const { dom, dialog, panel } = setup({
      onPin: () => calls.push('pin'),
      onPromote: () => calls.push('promote'),
      onDemote: () => calls.push('demote'),
      onAddTag: () => calls.push('add-tag'),
      onRemoveTag: (tag: string) => calls.push(`remove-tag:${tag}`),
      onDelete: () => calls.push('delete'),
      onEdit: () => calls.push('edit'),
    });
    try {
      panel.open(memory({ tags: ['cat:decision'] }), {});

      click(dom, query<HTMLElement>(dialog, '#btn-mem-pin')!);
      click(dom, query<HTMLElement>(dialog, '#btn-mem-promote')!);
      click(dom, query<HTMLElement>(dialog, '#btn-mem-demote')!);
      click(dom, query<HTMLElement>(dialog, '#mem-tags-row [data-action="add-tag"]')!);

      // The add-tag control now reveals the inline input instead of a prompt.
      expect(query<HTMLElement>(dialog, '#mem-tag-input-row')?.classList.contains('hidden')).toBe(
        false
      );

      click(
        dom,
        query<HTMLElement>(
          dialog,
          '#mem-tags-row [data-action="remove-tag"][data-tag="cat:decision"]'
        )!
      );
      click(dom, query<HTMLElement>(dialog, '#btn-mem-delete')!);
      click(dom, query<HTMLElement>(dialog, '#btn-mem-edit')!);

      expect(calls).toEqual([
        'pin',
        'promote',
        'demote',
        'add-tag',
        'remove-tag:cat:decision',
        'delete',
        'edit',
      ]);
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory panel command icons', () => {
  test('static commands use decorative sprite icons and keep visible labels', () => {
    const { dom, dialog } = setup();
    try {
      const expected: Array<[string, string, string]> = [
        ['#btn-mem-promote', 'arrow-up', 'Promote'],
        ['#btn-mem-demote', 'arrow-down', 'Demote'],
        ['#btn-mem-pin', 'pin', 'Pin'],
        ['#btn-mem-edit', 'pencil', 'Edit'],
        ['#btn-mem-delete', 'trash-2', 'Delete'],
        ['#btn-mem-save', 'check', 'Save'],
        ['#btn-mem-cancel-edit', 'x', 'Cancel'],
      ];

      for (const [selector, iconName, label] of expected) {
        const control = query<HTMLElement>(dialog, selector);
        expectDecorativeIcon(control, iconName);
        expect(control!.textContent).toContain(label);
      }
    } finally {
      dom.cleanup();
    }
  });

  test('Back and Close stay icon-only with their accessible names', () => {
    const { dom, dialog } = setup();
    try {
      const back = query<HTMLElement>(dialog, '#btn-mem-close');
      expectDecorativeIcon(back, 'arrow-left');
      expect(back!.getAttribute('aria-label')).toBe('Go back');
      expect(back!.textContent?.trim()).toBe('');

      const close = query<HTMLElement>(dialog, '#btn-mem-close-inline');
      expectDecorativeIcon(close, 'x');
      expect(close!.getAttribute('aria-label')).toBe('Close memory details');
      expect(close!.textContent?.trim()).toBe('');
    } finally {
      dom.cleanup();
    }
  });

  test('pin keeps its aria-pressed state, label text and icon after toggling', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.open(memory({ pinned: false }), {});
      const pin = query<HTMLButtonElement>(dialog, '#btn-mem-pin')!;
      expect(pin.getAttribute('aria-pressed')).toBe('false');
      expect(pin.querySelector('.pin-label')?.textContent).toBe('Pin');
      expectDecorativeIcon(pin, 'pin');

      panel.open(memory({ pinned: true }), {});
      expect(pin.getAttribute('aria-pressed')).toBe('true');
      expect(pin.querySelector('.pin-label')?.textContent).toBe('Unpin');
      expectDecorativeIcon(pin, 'pin');
    } finally {
      dom.cleanup();
    }
  });

  test('tag add and remove controls carry icons without losing their labels', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.open(memory({ tags: ['cat:decision'] }), {});

      const remove = query<HTMLElement>(
        dialog,
        '#mem-tags-row [data-action="remove-tag"][data-tag="cat:decision"]'
      );
      expect(remove?.tagName).toBe('BUTTON');
      expect(remove?.getAttribute('aria-label')).toBe('Remove tag cat:decision');
      expect(remove?.textContent).toContain('#cat:decision');
      expectDecorativeIcon(remove, 'x');

      const add = query<HTMLElement>(dialog, '#mem-tags-row [data-action="add-tag"]');
      expect(add?.tagName).toBe('BUTTON');
      expect(add?.getAttribute('aria-label')).toBe('Add tag');
      expect(add?.textContent).toContain('+ tag');
      expectDecorativeIcon(add, 'tag');
    } finally {
      dom.cleanup();
    }
  });

  test('the error retry action carries a rotate icon and keeps its label', () => {
    const { dom, dialog, panel } = setup();
    try {
      panel.setError('The memory could not be loaded.');

      const retry = query<HTMLElement>(dialog, '#mem-state [data-action="retry"]');
      expectDecorativeIcon(retry, 'rotate-ccw');
      expect(retry!.textContent).toContain('Try again');
    } finally {
      dom.cleanup();
    }
  });
});

describe('memory panel teardown', () => {
  test('destroy removes listeners so later events are ignored', () => {
    const calls: string[] = [];
    const { dom, dialog, panel } = setup({
      onClose: () => calls.push('close'),
      onPin: () => calls.push('pin'),
    });
    try {
      panel.open(memory(), {});
      panel.destroy();

      pressEscape(dom);
      click(dom, query<HTMLElement>(dialog, '#btn-mem-pin')!);

      expect(calls).toEqual([]);
    } finally {
      dom.cleanup();
    }
  });
});
