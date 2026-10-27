import { describe, expect, test } from 'bun:test';

import {
  isTypingTarget,
  resolveResultNavigation,
  setupSearchKeyboard,
} from '../src/app/search-keyboard.js';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * Keyboard shortcuts for the unified search surface.
 *
 * These are integration-level DOM tests: the helper binds one document
 * listener and operates on real focus, so the contract (focus the input, walk
 * the result links, clear or leave the input) is verified end to end without a
 * browser.
 */

function keydown(
  dom: DomHarness,
  target: Element | Document,
  key: string,
  init: Record<string, unknown> = {}
): KeyboardEvent {
  const event = new dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  } as never);
  target.dispatchEvent(event as never);
  return event as unknown as KeyboardEvent;
}

function createSearchDom(dom: DomHarness) {
  dom.document.body.innerHTML = `
    <input id="space-search" type="text" />
    <input id="other-field" type="text" />
    <div id="space-search-view">
      <a class="search-result-link" href="/spaces/a?memory=one">one</a>
      <a class="search-result-link" href="/spaces/a?memory=two">two</a>
      <a class="search-result-link" href="/spaces/a?memory=three">three</a>
    </div>
  `;

  const input = dom.document.getElementById('space-search') as HTMLInputElement;
  const links = Array.from(
    dom.document.querySelectorAll<HTMLElement>('.search-result-link')
  ) as HTMLElement[];

  return { input, links };
}

function setup(dom: DomHarness, initial = {}) {
  const { input, links } = createSearchDom(dom);
  let visible = true;
  let cleared = 0;
  const keyboard = setupSearchKeyboard({
    document: dom.document as unknown as Document,
    isSearchVisible: () => visible,
    onClearQuery: () => {
      cleared += 1;
    },
    ...initial,
  });

  return {
    input,
    links,
    keyboard,
    getCleared: () => cleared,
    setVisible: (next: boolean) => {
      visible = next;
    },
  };
}

describe('search keyboard helper', () => {
  test('isTypingTarget recognizes form controls and contenteditable regions', () => {
    const dom = installDom();
    try {
      const { input } = createSearchDom(dom);

      const textarea = dom.document.createElement('textarea');
      const select = dom.document.createElement('select');
      const button = dom.document.createElement('button');
      const editable = dom.document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      const paragraph = dom.document.createElement('p');

      expect(isTypingTarget(input)).toBe(true);
      expect(isTypingTarget(textarea)).toBe(true);
      expect(isTypingTarget(select)).toBe(true);
      expect(isTypingTarget(editable)).toBe(true);
      // Buttons are not text-entry controls: `/` must still focus search.
      expect(isTypingTarget(button)).toBe(false);
      expect(isTypingTarget(paragraph)).toBe(false);
      expect(isTypingTarget(null)).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('resolveResultNavigation moves within bounds from the input or a link', () => {
    expect(resolveResultNavigation({ key: 'ArrowDown', index: -1, count: 3 })).toBe(0);
    expect(resolveResultNavigation({ key: 'ArrowDown', index: 0, count: 3 })).toBe(1);
    expect(resolveResultNavigation({ key: 'ArrowDown', index: 2, count: 3 })).toBe(-1);
    expect(resolveResultNavigation({ key: 'ArrowUp', index: -1, count: 3 })).toBe(2);
    expect(resolveResultNavigation({ key: 'ArrowUp', index: 1, count: 3 })).toBe(0);
    expect(resolveResultNavigation({ key: 'ArrowUp', index: 0, count: 3 })).toBe(-1);
    expect(resolveResultNavigation({ key: 'Home', index: 2, count: 3 })).toBe(0);
    expect(resolveResultNavigation({ key: 'End', index: 0, count: 3 })).toBe(2);
    expect(resolveResultNavigation({ key: 'ArrowDown', index: -1, count: 0 })).toBe(-1);
  });
});

describe('search keyboard shortcuts', () => {
  test('"/" focuses the space search input', () => {
    const dom = installDom();
    try {
      const { input } = setup(dom);

      const event = keydown(dom, dom.document.body, '/');

      expect(dom.document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('"/" focuses the space search input from a focused button', () => {
    const dom = installDom();
    try {
      const { input } = setup(dom);
      const hamburger = dom.document.createElement('button');
      hamburger.id = 'hamburger-btn';
      dom.document.body.appendChild(hamburger);

      hamburger.focus();
      expect(dom.document.activeElement).toBe(hamburger);

      const event = keydown(dom, hamburger, '/');

      expect(dom.document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('"/" is ignored inside inputs, selects, contenteditable regions and with modifiers', () => {
    const dom = installDom();
    try {
      const { input } = setup(dom);
      const other = dom.document.getElementById('other-field') as HTMLInputElement;
      const select = dom.document.createElement('select');
      const editable = dom.document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      dom.document.body.appendChild(select);
      dom.document.body.appendChild(editable);

      other.focus();
      const inInput = keydown(dom, other, '/');
      expect(dom.document.activeElement).toBe(other);
      expect(inInput.defaultPrevented).toBe(false);

      select.focus();
      keydown(dom, select, '/');
      expect(dom.document.activeElement).toBe(select);

      editable.focus();
      keydown(dom, editable, '/');
      expect(dom.document.activeElement).toBe(editable);

      other.focus();
      const modified = keydown(dom, dom.document.body, '/', { ctrlKey: true });
      expect(dom.document.activeElement).toBe(other);
      expect(modified.defaultPrevented).toBe(false);

      keydown(dom, dom.document.body, '/', { metaKey: true });
      expect(dom.document.activeElement).not.toBe(input);
    } finally {
      dom.cleanup();
    }
  });

  test('arrows, Home and End move focus across result links in document order', () => {
    const dom = installDom();
    try {
      const { input, links } = setup(dom);

      input.focus();
      keydown(dom, input, 'ArrowDown');
      expect(dom.document.activeElement).toBe(links[0]);

      keydown(dom, links[0]!, 'ArrowDown');
      expect(dom.document.activeElement).toBe(links[1]);

      keydown(dom, links[1]!, 'ArrowUp');
      expect(dom.document.activeElement).toBe(links[0]);

      keydown(dom, links[0]!, 'End');
      expect(dom.document.activeElement).toBe(links[2]);

      keydown(dom, links[2]!, 'Home');
      expect(dom.document.activeElement).toBe(links[0]);

      keydown(dom, links[0]!, 'ArrowUp');
      expect(dom.document.activeElement).toBe(links[0]);
    } finally {
      dom.cleanup();
    }
  });

  test('does not prevent default when focus cannot move further', () => {
    const dom = installDom();
    try {
      const { links } = setup(dom);

      links[2]!.focus();
      const atEnd = keydown(dom, links[2]!, 'ArrowDown');
      expect(dom.document.activeElement).toBe(links[2]);
      expect(atEnd.defaultPrevented).toBe(false);

      links[0]!.focus();
      const atStart = keydown(dom, links[0]!, 'ArrowUp');
      expect(dom.document.activeElement).toBe(links[0]);
      expect(atStart.defaultPrevented).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('leaves Home/End to other controls such as the view toggle', () => {
    const dom = installDom();
    try {
      const { links } = setup(dom);
      const toggle = dom.document.createElement('button');
      dom.document.body.appendChild(toggle);

      toggle.focus();
      keydown(dom, toggle, 'Home');

      expect(dom.document.activeElement).toBe(toggle);
      expect(links[0]).not.toBe(dom.document.activeElement);
    } finally {
      dom.cleanup();
    }
  });

  test('Escape clears the query in the input and keeps focus', () => {
    const dom = installDom();
    try {
      const { input, getCleared } = setup(dom);
      input.value = 'auth';
      input.focus();

      const event = keydown(dom, input, 'Escape');

      expect(getCleared()).toBe(1);
      expect(input.value).toBe('');
      expect(dom.document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('Escape on a result link returns focus to the search input', () => {
    const dom = installDom();
    try {
      const { input, links, getCleared } = setup(dom);
      links[1]!.focus();

      const event = keydown(dom, links[1]!, 'Escape');

      expect(dom.document.activeElement).toBe(input);
      expect(getCleared()).toBe(0);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      dom.cleanup();
    }
  });

  test('"/" focuses the input and Escape clears it even while results are hidden', () => {
    const dom = installDom();
    try {
      const { input, links, getCleared, setVisible } = setup(dom);
      setVisible(false);

      dom.document.body.focus();
      const slash = keydown(dom, dom.document.body, '/');
      expect(dom.document.activeElement).toBe(input);
      expect(slash.defaultPrevented).toBe(true);

      input.value = 'auth';
      input.focus();
      const escape = keydown(dom, input, 'Escape');
      expect(input.value).toBe('');
      expect(getCleared()).toBe(1);
      expect(dom.document.activeElement).toBe(input);
      expect(escape.defaultPrevented).toBe(true);

      // Result navigation still requires a visible search surface.
      input.focus();
      keydown(dom, input, 'ArrowDown');
      expect(dom.document.activeElement).toBe(input);
      expect(links[0]).not.toBe(dom.document.activeElement);
    } finally {
      dom.cleanup();
    }
  });

  test('Escape on a result link is inert while the search surface is hidden', () => {
    const dom = installDom();
    try {
      const { links, getCleared, setVisible } = setup(dom);
      setVisible(false);
      links[1]!.focus();

      const event = keydown(dom, links[1]!, 'Escape');

      expect(dom.document.activeElement).toBe(links[1]);
      expect(getCleared()).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('destroy removes the single document listener', () => {
    const dom = installDom();
    try {
      const { input, keyboard } = setup(dom);
      keyboard.destroy();
      keyboard.destroy();

      const event = keydown(dom, dom.document.body, '/');

      expect(dom.document.activeElement).not.toBe(input);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      dom.cleanup();
    }
  });
});
