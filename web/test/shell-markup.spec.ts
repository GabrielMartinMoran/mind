import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { installDom } from './helpers/dom';

const repoRoot = join(import.meta.dir, '../..');
const indexHtmlPath = join(repoRoot, 'web/public/index.html');
const appJsPath = join(repoRoot, 'web/src/app.js');
const graphViewPath = join(repoRoot, 'web/src/views/graph-view.js');

/** IDs created by app.js at runtime rather than declared in the shell. */
const DYNAMICALLY_CREATED_IDS = new Set<string>();

const VIEW_CONTAINERS = ['#empty-state', '#space-detail', '#logs-page'];

function loadShell(): { document: Document; cleanup: () => void } {
  const html = readFileSync(indexHtmlPath, 'utf8');
  const harness = installDom();
  const document = new harness.window.DOMParser().parseFromString(html, 'text/html');

  return { document: document as unknown as Document, cleanup: harness.cleanup };
}

function extractReferencedIds(source: string): Set<string> {
  const ids = new Set<string>();
  const patterns = [
    /\$\('([^']+)'\)/g,
    /getElementById\(['"]([^'"]+)['"]\)/g,
    /querySelector(?:All)?\(\s*[`'"]#([A-Za-z0-9_-]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const id = match[1];
      if (id) ids.add(id);
    }
  }

  return ids;
}

function assetValues(source: string, attributeName: 'href' | 'src'): string[] {
  const pattern = new RegExp(`${attributeName}="([^"]+)"`, 'g');
  return Array.from(source.matchAll(pattern), match => match[1] ?? '');
}

/** Every sprite reference used by an icon inside `root`, in DOM order. */
function iconHrefs(root: Element | null): string[] {
  return Array.from(root?.querySelectorAll('svg use') ?? []).map(
    use => use.getAttribute('href') ?? ''
  );
}

function expectDecorativeIcons(root: Element | null): void {
  const icons = Array.from(root?.querySelectorAll('svg') ?? []);
  expect(icons.length).toBeGreaterThan(0);

  for (const icon of icons) {
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('focusable')).toBe('false');
  }
}

describe('Memory Atlas shell markup', () => {
  test('exposes skip link and the banner, navigation and main landmarks', () => {
    const { document, cleanup } = loadShell();

    try {
      const skipLink = document.querySelector('a.skip-link');
      expect(skipLink?.getAttribute('href')).toBe('#main-content');

      const banner = document.querySelector('header.app-topbar');
      expect(banner).not.toBeNull();
      expect(banner?.closest('main')).toBeNull();

      const navigation = document.querySelector('#sidebar nav[aria-label="Spaces"]');
      expect(navigation).not.toBeNull();

      const main = document.querySelector('main#main-content');
      expect(main).not.toBeNull();
      expect(main?.getAttribute('tabindex')).toBe('-1');
    } finally {
      cleanup();
    }
  });

  test('renders exactly one h1 inside each view container', () => {
    const { document, cleanup } = loadShell();

    try {
      for (const selector of VIEW_CONTAINERS) {
        const view = document.querySelector(selector);
        expect(view, `${selector} should exist`).not.toBeNull();
        expect(view?.querySelectorAll('h1').length, `${selector} should own exactly one h1`).toBe(
          1
        );
      }
    } finally {
      cleanup();
    }
  });

  test('gives the in-space search an accessible label and keeps it inside the space header', () => {
    const { document, cleanup } = loadShell();

    try {
      const topbar = document.querySelector('header.app-topbar');
      expect(topbar?.querySelector('#global-search')).toBeNull();

      const spaceHeader = document.querySelector('#space-detail > .panel-header');
      const search = spaceHeader?.querySelector<HTMLInputElement>('#space-search');
      expect(search).not.toBeNull();

      const labelledBy = search?.getAttribute('aria-labelledby');
      const ariaLabel = search?.getAttribute('aria-label');
      const label = search?.id ? document.querySelector(`label[for="${search.id}"]`) : null;
      const wrapped = search?.closest('label');

      const hasAccessibleName =
        Boolean(ariaLabel?.trim()) ||
        Boolean(labelledBy && document.getElementById(labelledBy)?.textContent?.trim()) ||
        Boolean(label?.textContent?.trim()) ||
        Boolean(wrapped?.textContent?.trim());

      expect(hasAccessibleName).toBe(true);
      expect(document.querySelector('#btn-clear-space-search')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('places the mobile menu button outside the sidebar drawer', () => {
    const { document, cleanup } = loadShell();

    try {
      const menuButton = document.querySelector('#hamburger-btn');
      expect(menuButton).not.toBeNull();
      expect(menuButton?.closest('#sidebar')).toBeNull();

      const topbar = document.querySelector('header.app-topbar');
      expect(Boolean(topbar?.contains(menuButton))).toBe(true);
      expect(menuButton?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      cleanup();
    }
  });

  test('space rail keeps its navigation, space list, hidden toggle and status panel', () => {
    const { document, cleanup } = loadShell();

    try {
      const sidebar = document.querySelector('#sidebar');
      expect(sidebar).not.toBeNull();
      expect(sidebar?.querySelector('#space-list')).not.toBeNull();
      expect(sidebar?.querySelector('#toggle-hidden-spaces')).not.toBeNull();
      expect(sidebar?.querySelector('#status-panel')).not.toBeNull();
      expect(sidebar?.querySelector('.sidebar-close')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('All spaces is the first sidebar entry and the topbar has no breadcrumb', () => {
    const { document, cleanup } = loadShell();

    try {
      expect(document.querySelector('.breadcrumb')).toBeNull();
      expect(document.getElementById('breadcrumb-space')).toBeNull();

      const navigation = document.querySelector('#sidebar nav[aria-label="Spaces"]');
      const allSpaces = navigation?.querySelector('#all-spaces-link');
      const spaceList = navigation?.querySelector('#space-list');

      expect(allSpaces).not.toBeNull();
      expect(allSpaces?.tagName).toBe('A');
      expect(allSpaces?.getAttribute('href')).toBe('/');
      expect(allSpaces?.classList.contains('nav-item')).toBe(true);
      expect(allSpaces?.textContent?.trim()).toBe('All spaces');
      expect(allSpaces?.querySelector('svg')).not.toBeNull();

      const children = Array.from(navigation?.children ?? []);
      expect(children[0]).toBe(allSpaces);
      expect(children[1]).toBe(spaceList);
    } finally {
      cleanup();
    }
  });

  test('view toggle buttons expose identity, view and pressed state', () => {
    const { document, cleanup } = loadShell();

    try {
      const buttons = Array.from(document.querySelectorAll('.view-toggle-btn'));
      expect(buttons.length).toBeGreaterThanOrEqual(2);

      const views = buttons.map(button => button.getAttribute('data-view'));
      expect(new Set(views)).toEqual(new Set(['list', 'map']));

      for (const button of buttons) {
        expect(button.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
      }

      expect(document.querySelector('#btn-view-list.view-toggle-btn')).not.toBeNull();
      expect(document.querySelector('#btn-view-map.view-toggle-btn')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('topbar actions share one sizing contract', () => {
    const { document, cleanup } = loadShell();

    try {
      const newSpace = document.getElementById('btn-new-space');
      const logs = document.getElementById('logs-link');

      expect(newSpace?.classList.contains('topbar-action')).toBe(true);
      expect(logs?.classList.contains('topbar-action')).toBe(true);
      expect(newSpace?.closest('.topbar-actions')).not.toBeNull();
      expect(logs?.closest('.topbar-actions')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test('topbar exposes a quiet New space command and a visible secondary Logs link', () => {
    const { document, cleanup } = loadShell();

    try {
      const newSpace = document.getElementById('btn-new-space');
      const logs = document.getElementById('logs-link');

      expect(newSpace?.classList.contains('btn-quiet')).toBe(true);
      expect(newSpace?.classList.contains('btn-primary')).toBe(false);
      expect(logs?.tagName).toBe('A');
      expect(logs?.getAttribute('href')).toBe('/logs');
      expect(logs?.classList.contains('btn-secondary')).toBe(true);
      expect(logs?.classList.contains('btn-primary')).toBe(false);

      expect(newSpace?.querySelector('.btn-label')?.textContent?.trim()).toBe('New space');
      expect(logs?.querySelector('.btn-label')?.textContent?.trim()).toBe('Logs');
      expect(newSpace?.getAttribute('aria-label')?.trim()).toBeTruthy();
      expect(logs?.getAttribute('aria-label')?.trim()).toBeTruthy();

      expect(iconHrefs(newSpace)).toEqual(['/assets/icons.svg#icon-folder-plus']);
      expect(iconHrefs(logs)).toEqual(['/assets/icons.svg#icon-file-text']);
      expectDecorativeIcons(newSpace);
      expectDecorativeIcons(logs);
    } finally {
      cleanup();
    }
  });

  test('New memory sits beside the space title instead of the action row', () => {
    const { document, cleanup } = loadShell();

    try {
      const identity = document.querySelector('#space-detail .space-identity');
      expect(identity).not.toBeNull();
      expect(identity?.querySelector('#space-title')).not.toBeNull();

      const addMemory = identity?.querySelector('#btn-add-memory');
      expect(addMemory).not.toBeNull();
      expect(document.querySelector('#space-detail .panel-actions #btn-add-memory')).toBeNull();

      expect(addMemory?.querySelector('.btn-label')?.textContent?.trim()).toBe('New memory');
      expect(addMemory?.classList.contains('btn-primary')).toBe(false);
      expect(iconHrefs(addMemory)).toEqual(['/assets/icons.svg#icon-file-plus']);
      expectDecorativeIcons(addMemory);
    } finally {
      cleanup();
    }
  });

  test('space action row keeps the view toggle and an outlined delete control', () => {
    const { document, cleanup } = loadShell();

    try {
      const actions = document.querySelector('#space-detail .panel-actions');
      expect(actions).not.toBeNull();
      const controls = Array.from(actions?.children ?? []);
      expect(controls).toHaveLength(2);
      expect(controls[0]?.classList.contains('view-toggle')).toBe(true);
      expect(controls.at(-1)?.id).toBe('btn-delete-space');

      const deleteSpace = document.querySelector('#btn-delete-space');
      expect(deleteSpace?.classList.contains('btn-danger-outline')).toBe(true);
      expect(deleteSpace?.classList.contains('btn-danger')).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('Delete space pairs the local trash-2 icon with its visible label', () => {
    const { document, cleanup } = loadShell();

    try {
      const deleteSpace = document.querySelector('#btn-delete-space');
      expect(deleteSpace).not.toBeNull();

      // The sprite already ships trash-2; no new icon dependency is added.
      expect(iconHrefs(deleteSpace)).toEqual(['/assets/icons.svg#icon-trash-2']);
      expectDecorativeIcons(deleteSpace);

      // The visible label is the accessible name, so no aria-label override.
      expect(deleteSpace?.querySelector('.btn-label')?.textContent?.trim()).toBe('Delete space');
      expect(deleteSpace?.textContent?.trim()).toBe('Delete space');
      expect(deleteSpace?.getAttribute('aria-label')).toBeNull();

      // The trigger stays outlined so it never competes with the primary action.
      expect(deleteSpace?.classList.contains('btn-danger-outline')).toBe(true);
      expect(deleteSpace?.classList.contains('btn-danger')).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('view toggle buttons pair decorative icons with visible labels', () => {
    const { document, cleanup } = loadShell();

    try {
      const expectations: Array<[string, string, string]> = [
        ['#btn-view-list', 'List', '/assets/icons.svg#icon-list'],
        ['#btn-view-map', 'Neural Map', '/assets/icons.svg#icon-network'],
      ];

      for (const [selector, label, href] of expectations) {
        const button = document.querySelector(selector);
        expect(button, `${selector} should exist`).not.toBeNull();
        expect(button?.querySelector('.btn-label')?.textContent?.trim()).toBe(label);
        expect(iconHrefs(button)).toEqual([href]);
        expectDecorativeIcons(button);
      }
    } finally {
      cleanup();
    }
  });

  test('space detail owns the in-space search surface and its results root', () => {
    const { document, cleanup } = loadShell();

    try {
      const spaceDetail = document.querySelector('#space-detail');
      const searchView = spaceDetail?.querySelector('#space-search-view');
      expect(searchView).not.toBeNull();
      expect(searchView?.classList.contains('hidden')).toBe(true);

      // The global search page and its headings are gone.
      expect(document.querySelector('#search-results')).toBeNull();
      expect(document.querySelector('#search-view')).toBeNull();
      expect(document.querySelector('#search-heading')).toBeNull();

      // The legacy list was replaced by the search page composition layer.
      expect(document.querySelector('#search-list')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('space detail exposes the memory list container and no legacy tier lists', () => {
    const { document, cleanup } = loadShell();

    try {
      const spaceDetail = document.querySelector('#space-detail');
      expect(spaceDetail).not.toBeNull();
      expect(spaceDetail?.querySelector('#list-view')).not.toBeNull();

      expect(document.querySelector('#tiers')).toBeNull();
      expect(document.querySelector('#space-detail ul.memory-list[data-tier]')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('declares every DOM id that app.js looks up', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');
    const { document, cleanup } = loadShell();

    try {
      const referencedIds = extractReferencedIds(readFileSync(appJsPath, 'utf8'));
      const missing = Array.from(referencedIds)
        .filter(id => !DYNAMICALLY_CREATED_IDS.has(id))
        .filter(id => document.getElementById(id) === null);

      expect(referencedIds.size).toBeGreaterThan(40);
      expect(missing).toEqual([]);
      expect(html).toContain('id="main-content"');
    } finally {
      cleanup();
    }
  });

  test('graph toolbar controls are owned by the view, not the shell', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');
    const graphView = readFileSync(graphViewPath, 'utf8');
    const appIds = extractReferencedIds(readFileSync(appJsPath, 'utf8'));

    // `graph-view.js` builds these controls per render and wires them itself.
    // They must not also exist as static shell markup (a duplicate id would be
    // created at runtime), and `app.js` must not reach into them by id.
    for (const id of [
      'btn-graph-zoom-in',
      'btn-graph-zoom-out',
      'btn-graph-reset',
      'graph-retry',
    ]) {
      expect(html, `${id} must not be declared in index.html`).not.toContain(`id="${id}"`);
      expect(graphView, `${id} must be generated by graph-view.js`).toContain(`'${id}'`);
      expect(appIds.has(id), `${id} must be owned by the view, not app.js`).toBe(false);
    }
  });

  test('loads marked locally and makes no CDN requests', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');

    expect(assetValues(html, 'src')).toContain('/assets/vendor/marked.min.js');

    const remoteAssets = [...assetValues(html, 'href'), ...assetValues(html, 'src')].filter(value =>
      /^(https?:)?\/\//i.test(value)
    );
    expect(remoteAssets).toEqual([]);
  });
});
