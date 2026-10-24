import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { buildAppUrl } from '../src/features/routing/routing.js';
import { setupSpaNavigation, setupViewToggle } from '../src/views/shell.js';

import { installDom, type DomHarness } from './helpers/dom';

const repoRoot = join(import.meta.dir, '../..');
const shellSource = readFileSync(join(repoRoot, 'web/src/views/shell.js'), 'utf8');
const appSource = readFileSync(join(repoRoot, 'web/src/app.js'), 'utf8');
const indexSource = readFileSync(join(repoRoot, 'web/public/index.html'), 'utf8');

interface NavHarness {
  dom: DomHarness;
  controller: ReturnType<typeof setupSpaNavigation>;
  navigations: string[];
}

function createNavHarness(): NavHarness {
  const dom = installDom();
  dom.document.body.innerHTML = `
    <a class="brand" id="brand-link" href="/">Mind</a>
    <a id="all-spaces-link" class="nav-item" href="/">All spaces</a>
    <a id="logs-link" href="/logs">Logs</a>
  `;

  const navigations: string[] = [];
  const controller = setupSpaNavigation({
    document: dom.document,
    window: dom.window as unknown as Window,
    onNavigate: path => navigations.push(path),
  });

  return { dom, controller, navigations };
}

function click(dom: DomHarness, target: Element, init: Record<string, unknown> = {}): any {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ...init,
  } as any);
  target.dispatchEvent(event as any);
  return event;
}

function pressKey(dom: DomHarness, target: EventTarget, key: string): any {
  const event = new dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event as any);
  return event;
}

interface ToggleHarness {
  dom: DomHarness;
  controller: ReturnType<typeof setupViewToggle>;
  selections: string[];
  listButton: HTMLButtonElement;
  mapButton: HTMLButtonElement;
}

function createToggleHarness(): ToggleHarness {
  const dom = installDom();
  dom.document.body.innerHTML = `
    <div class="view-toggle" role="group" aria-label="Space view">
      <button id="btn-view-list" class="view-toggle-btn is-active" type="button" data-view="list" aria-pressed="true">List</button>
      <button id="btn-view-map" class="view-toggle-btn" type="button" data-view="map" aria-pressed="false">Neural Map</button>
    </div>
  `;

  const selections: string[] = [];
  let windowRef = dom.window as unknown as Window;
  const controller = setupViewToggle({
    document: dom.document,
    window: windowRef,
    onSelect: view => {
      selections.push(view);
      const url = buildAppUrl({ spaceName: 'test', view });
      windowRef.history.replaceState({}, '', url);
    },
  });

  const listButton = dom.document.getElementById('btn-view-list') as HTMLButtonElement;
  const mapButton = dom.document.getElementById('btn-view-map') as HTMLButtonElement;

  return { dom, controller, selections, listButton, mapButton };
}

describe('SPA navigation links', () => {
  test('logs link pushes /logs and invokes the route callback without a full navigation', () => {
    const harness = createNavHarness();

    try {
      const link = harness.dom.document.getElementById('logs-link') as HTMLAnchorElement;
      const event = click(harness.dom, link);

      expect(event.defaultPrevented).toBe(true);
      expect(harness.dom.window.location.pathname).toBe('/logs');
      expect(harness.navigations).toEqual(['/logs']);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('brand link pushes / and invokes the route callback', () => {
    const harness = createNavHarness();

    try {
      const link = harness.dom.document.getElementById('brand-link') as HTMLAnchorElement;
      const event = click(harness.dom, link);

      expect(event.defaultPrevented).toBe(true);
      expect(harness.dom.window.location.pathname).toBe('/');
      expect(harness.navigations).toEqual(['/']);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('All spaces pushes / and invokes the route callback without a reload', () => {
    const harness = createNavHarness();

    try {
      const link = harness.dom.document.getElementById('all-spaces-link') as HTMLAnchorElement;
      const event = click(harness.dom, link);

      expect(event.defaultPrevented).toBe(true);
      expect(harness.dom.window.location.pathname).toBe('/');
      expect(harness.navigations).toEqual(['/']);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('keeps modifier and middle clicks as normal browser navigation', () => {
    const harness = createNavHarness();

    try {
      const logs = harness.dom.document.getElementById('logs-link') as HTMLAnchorElement;

      for (const init of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const event = click(harness.dom, logs, init);
        expect(event.defaultPrevented).toBe(false);
      }

      expect(harness.navigations).toEqual([]);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });
});

describe('space view toggle', () => {
  test('exposes a single roving tab stop', () => {
    const harness = createToggleHarness();

    try {
      expect(harness.listButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.mapButton.getAttribute('aria-pressed')).toBe('false');
      expect(harness.listButton.getAttribute('tabindex')).toBe('0');
      expect(harness.mapButton.getAttribute('tabindex')).toBe('-1');
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('clicking map updates aria-pressed, URL and callback', () => {
    const harness = createToggleHarness();

    try {
      click(harness.dom, harness.mapButton);

      expect(harness.mapButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.listButton.getAttribute('aria-pressed')).toBe('false');
      expect(harness.mapButton.getAttribute('tabindex')).toBe('0');
      expect(harness.listButton.getAttribute('tabindex')).toBe('-1');
      expect(harness.selections).toEqual(['map']);
      expect(harness.dom.window.location.pathname).toBe('/spaces/test');
      expect(harness.dom.window.location.search).toBe('?view=map');
      expect(harness.dom.document.activeElement).toBe(harness.mapButton);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('switching back to list omits the view param', () => {
    const harness = createToggleHarness();

    try {
      click(harness.dom, harness.mapButton);
      click(harness.dom, harness.listButton);

      expect(harness.listButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.mapButton.getAttribute('aria-pressed')).toBe('false');
      expect(harness.selections).toEqual(['map', 'list']);
      expect(harness.dom.window.location.pathname).toBe('/spaces/test');
      expect(harness.dom.window.location.search).toBe('');
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('ArrowRight and ArrowLeft move and activate the toggles, keeping focus', () => {
    const harness = createToggleHarness();

    try {
      harness.listButton.focus();

      const right = pressKey(harness.dom, harness.listButton, 'ArrowRight');
      expect(right.defaultPrevented).toBe(true);
      expect(harness.mapButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.dom.document.activeElement).toBe(harness.mapButton);

      const left = pressKey(harness.dom, harness.mapButton, 'ArrowLeft');
      expect(left.defaultPrevented).toBe(true);
      expect(harness.listButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.dom.document.activeElement).toBe(harness.listButton);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });

  test('Home and End jump to the first and last toggles', () => {
    const harness = createToggleHarness();

    try {
      harness.listButton.focus();

      pressKey(harness.dom, harness.listButton, 'End');
      expect(harness.mapButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.dom.document.activeElement).toBe(harness.mapButton);

      pressKey(harness.dom, harness.mapButton, 'Home');
      expect(harness.listButton.getAttribute('aria-pressed')).toBe('true');
      expect(harness.dom.document.activeElement).toBe(harness.listButton);
    } finally {
      harness.controller.destroy();
      harness.dom.cleanup();
    }
  });
});

describe('shell action markup contracts', () => {
  test('view toggle markup keeps decorative icons with visible text labels', () => {
    for (const [id, name, label] of [
      ['btn-view-list', 'list', 'List'],
      ['btn-view-map', 'network', 'Neural Map'],
    ] as const) {
      const button = new RegExp(
        `id="${id}"[\\s\\S]*?<use href="/assets/icons\\.svg#icon-${name}"></use>[\\s\\S]*?<span class="btn-label">${label}</span>[\\s\\S]*?</button>`
      );
      expect(indexSource, `${id} should pair its icon with a visible label`).toMatch(button);
      expect(indexSource).toMatch(
        new RegExp(`id="${id}"[\\s\\S]*?<svg[^>]*aria-hidden="true"[^>]*focusable="false"`)
      );
    }
  });

  test('Logs stays a real anchor so modifier clicks remain browser navigation', () => {
    expect(indexSource).toMatch(
      /<a\s+href="\/logs"\s+id="logs-link"\s+class="[^"]*btn-secondary[^"]*topbar-action[^"]*"/
    );
  });
});

describe('shell navigation cleanup', () => {
  test('the obsolete view-toggle-track wiring is gone', () => {
    expect(indexSource).not.toContain('view-toggle-track');
    expect(appSource).not.toContain('view-toggle-track');
    expect(shellSource).not.toContain('view-toggle-track');
  });

  test('destroy removes SPA navigation listeners', () => {
    const harness = createNavHarness();

    try {
      harness.controller.destroy();
      const link = harness.dom.document.getElementById('logs-link') as HTMLAnchorElement;
      const event = click(harness.dom, link);

      expect(event.defaultPrevented).toBe(false);
      expect(harness.navigations).toEqual([]);
    } finally {
      harness.dom.cleanup();
    }
  });
});
