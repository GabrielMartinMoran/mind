import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { setupShell } from '../src/views/shell.js';

import { installDom } from './helpers/dom';

const repoRoot = join(import.meta.dir, '../..');
const indexHtmlPath = join(repoRoot, 'web/public/index.html');
const MOBILE_BREAKPOINT_QUERY = '(max-width: 860px)';

interface ShellHarness {
  window: any;
  document: Document;
  controller: ReturnType<typeof setupShell>;
  setMobile: (mobile: boolean) => void;
  cleanup: () => void;
}

function createHarness(
  options: { onNavigate?: (anchor: unknown, event: Event) => void } = {}
): ShellHarness {
  const dom = installDom();
  const html = readFileSync(indexHtmlPath, 'utf8');
  const document = new dom.window.DOMParser().parseFromString(
    html,
    'text/html'
  ) as unknown as Document;

  let mobile = true;
  dom.window.innerWidth = 375;
  dom.window.matchMedia = ((query: string) => ({
    matches: query === MOBILE_BREAKPOINT_QUERY ? mobile : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof dom.window.matchMedia;

  const controller = setupShell({
    document,
    window: dom.window as unknown as Window,
    onNavigate: options.onNavigate,
  });

  return {
    window: dom.window,
    document,
    controller,
    setMobile(next: boolean) {
      mobile = next;
      dom.window.innerWidth = next ? 375 : 1200;
    },
    cleanup() {
      controller.destroy();
      dom.cleanup();
    },
  };
}

function byId(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function pressKey(
  harness: ShellHarness,
  key: string,
  target: EventTarget,
  shiftKey = false
): Event {
  const event = new harness.window.KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('responsive navigation drawer', () => {
  test('compact topbar actions keep accessible names when their labels collapse', () => {
    const harness = createHarness();

    try {
      const newSpace = byId(harness.document, 'btn-new-space');
      const logs = byId(harness.document, 'logs-link');

      for (const control of [newSpace, logs]) {
        expect(control.getAttribute('aria-label')?.trim()).toBeTruthy();
        expect(control.querySelector('.btn-label')?.textContent?.trim()).toBeTruthy();
        expect(control.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(control.querySelector('svg')?.getAttribute('focusable')).toBe('false');
      }

      expect(logs.tagName).toBe('A');
      expect(logs.getAttribute('href')).toBe('/logs');
    } finally {
      harness.cleanup();
    }
  });

  test('opens the drawer with modal semantics, inert background and focus inside', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const overlay = byId(harness.document, 'sidebar-overlay');
      const hamburger = byId(harness.document, 'hamburger-btn');
      const main = byId(harness.document, 'main-content');

      harness.controller.open();

      expect(sidebar.classList.contains('is-open')).toBe(true);
      expect(sidebar.classList.contains('sidebar-open')).toBe(true);
      expect(overlay.classList.contains('overlay-hidden')).toBe(false);
      expect(overlay.hidden).toBe(false);
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');
      expect(sidebar.getAttribute('aria-modal')).toBe('true');
      expect(sidebar.getAttribute('role')).toBe('dialog');
      expect(main.hasAttribute('inert')).toBe(true);
      expect(harness.document.body.classList.contains('drawer-open')).toBe(true);
      expect(sidebar.contains(harness.document.activeElement)).toBe(true);
      expect(harness.document.activeElement?.id).toBe('sidebar-close');
    } finally {
      harness.cleanup();
    }
  });

  test('traps Tab and Shift+Tab inside the drawer', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const closeButton = byId(harness.document, 'sidebar-close');
      const hiddenToggle = byId(harness.document, 'toggle-hidden-spaces');

      harness.controller.open();

      hiddenToggle.focus();
      expect(harness.document.activeElement).toBe(hiddenToggle);

      const forward = pressKey(harness, 'Tab', hiddenToggle);
      expect(forward.defaultPrevented).toBe(true);
      expect(harness.document.activeElement).toBe(closeButton);

      const backward = pressKey(harness, 'Tab', closeButton, true);
      expect(backward.defaultPrevented).toBe(true);
      expect(harness.document.activeElement).toBe(hiddenToggle);
      expect(sidebar.contains(harness.document.activeElement)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test('Escape closes the drawer and returns focus to the menu button', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const overlay = byId(harness.document, 'sidebar-overlay');
      const hamburger = byId(harness.document, 'hamburger-btn');
      const main = byId(harness.document, 'main-content');

      harness.controller.open();
      pressKey(harness, 'Escape', harness.document);

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(sidebar.classList.contains('sidebar-open')).toBe(false);
      expect(sidebar.hasAttribute('role')).toBe(false);
      expect(sidebar.hasAttribute('aria-modal')).toBe(false);
      expect(hamburger.getAttribute('aria-expanded')).toBe('false');
      expect(main.hasAttribute('inert')).toBe(false);
      expect(harness.document.body.classList.contains('drawer-open')).toBe(false);
      expect(overlay.classList.contains('overlay-hidden')).toBe(true);
      expect(harness.document.activeElement).toBe(hamburger);
    } finally {
      harness.cleanup();
    }
  });

  test('the sidebar close button closes the drawer and returns focus to the menu button', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const hamburger = byId(harness.document, 'hamburger-btn');
      const closeButton = byId(harness.document, 'sidebar-close');

      harness.controller.open();
      closeButton.click();

      expect(harness.controller.isOpen()).toBe(false);
      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(harness.document.body.classList.contains('drawer-open')).toBe(false);
      expect(harness.document.activeElement).toBe(hamburger);
    } finally {
      harness.cleanup();
    }
  });

  test('clicking the overlay closes the drawer', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const overlay = byId(harness.document, 'sidebar-overlay');

      harness.controller.open();
      overlay.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(harness.document.body.classList.contains('drawer-open')).toBe(false);
      expect(harness.document.activeElement?.id).toBe('hamburger-btn');
    } finally {
      harness.cleanup();
    }
  });

  test('clicking a navigation link closes the drawer without cancelling the click', () => {
    let navigations = 0;
    const harness = createHarness({
      onNavigate: () => {
        navigations += 1;
      },
    });

    try {
      const sidebar = byId(harness.document, 'sidebar');
      const spaceList = byId(harness.document, 'space-list');
      const link = harness.document.createElement('a');
      link.href = '/spaces/projects%2Fmind';
      link.textContent = 'projects/mind';
      spaceList.appendChild(link);

      harness.controller.open();
      const event = new harness.window.MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(navigations).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  test('clicking All spaces closes the drawer and reports the navigation', () => {
    let navigations = 0;
    const harness = createHarness({
      onNavigate: () => {
        navigations += 1;
      },
    });

    try {
      const sidebar = byId(harness.document, 'sidebar');
      const allSpaces = byId(harness.document, 'all-spaces-link');

      harness.controller.open();
      allSpaces.dispatchEvent(
        new harness.window.MouseEvent('click', { bubbles: true, cancelable: true })
      );

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(navigations).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  test('resizing to desktop clears the modal drawer state', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const overlay = byId(harness.document, 'sidebar-overlay');
      const hamburger = byId(harness.document, 'hamburger-btn');
      const main = byId(harness.document, 'main-content');

      harness.controller.open();
      harness.setMobile(false);
      harness.window.dispatchEvent(new harness.window.Event('resize'));

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(sidebar.hasAttribute('role')).toBe(false);
      expect(sidebar.hasAttribute('aria-modal')).toBe(false);
      expect(hamburger.getAttribute('aria-expanded')).toBe('false');
      expect(main.hasAttribute('inert')).toBe(false);
      expect(overlay.classList.contains('overlay-hidden')).toBe(true);
      expect(harness.document.body.classList.contains('drawer-open')).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  test('destroy removes listeners and disables the controller', () => {
    const harness = createHarness();
    try {
      const sidebar = byId(harness.document, 'sidebar');
      const hamburger = byId(harness.document, 'hamburger-btn');

      harness.controller.destroy();
      hamburger.click();

      expect(sidebar.classList.contains('is-open')).toBe(false);
      expect(harness.controller.open()).toBe(false);
    } finally {
      harness.cleanup();
    }
  });
});
