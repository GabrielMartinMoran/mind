import { describe, expect, test } from 'bun:test';

import { setupMemoryKeyboard } from '../src/app/memory-keyboard.js';

import { installDom, type DomHarness } from './helpers/dom';

function buildList(dom: DomHarness, { hidden = false }: { hidden?: boolean } = {}): void {
  dom.document.body.innerHTML = `
    <div id="space-detail"${hidden ? ' class="hidden"' : ''}>
      <div id="list-view">
        <a class="memory-card-link" href="/spaces/s?memory=a">a</a>
        <a class="memory-card-link" href="/spaces/s?memory=b">b</a>
        <a class="memory-card-link" href="/spaces/s?memory=c">c</a>
      </div>
    </div>
    <div class="view-toggle">
      <button class="view-toggle-btn" type="button">List</button>
    </div>
    <input id="outside-filter" />
  `;
}

function links(dom: DomHarness): HTMLElement[] {
  return Array.from(dom.document.querySelectorAll<HTMLElement>('#list-view .memory-card-link'));
}

function press(dom: DomHarness, target: EventTarget, key: string): any {
  const event = new dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  } as never);
  target.dispatchEvent(event as never);
  return event;
}

describe('memory list keyboard navigation', () => {
  test('ArrowDown and ArrowUp move between card links without leaving the list', () => {
    const dom = installDom();
    try {
      buildList(dom);
      const controller = setupMemoryKeyboard({ document: dom.document });
      const [first, second] = links(dom);

      first!.focus();
      const down = press(dom, first!, 'ArrowDown');
      expect(down.defaultPrevented).toBe(true);
      expect(dom.document.activeElement).toBe(second!);

      const up = press(dom, second!, 'ArrowUp');
      expect(up.defaultPrevented).toBe(true);
      expect(dom.document.activeElement).toBe(first!);

      // ArrowUp on the first card does not wrap; it also does not scroll.
      const edge = press(dom, first!, 'ArrowUp');
      expect(edge.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(first!);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });

  test('ArrowDown on the last card does not move or prevent scrolling', () => {
    const dom = installDom();
    try {
      buildList(dom);
      const controller = setupMemoryKeyboard({ document: dom.document });
      const last = links(dom).at(-1)!;

      last.focus();
      const event = press(dom, last, 'ArrowDown');

      expect(event.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(last);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });

  test('Home and End jump to the first and last card', () => {
    const dom = installDom();
    try {
      buildList(dom);
      const controller = setupMemoryKeyboard({ document: dom.document });
      const [first, , third] = links(dom);

      first!.focus();
      press(dom, first!, 'End');
      expect(dom.document.activeElement).toBe(third!);

      press(dom, third!, 'Home');
      expect(dom.document.activeElement).toBe(first!);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });

  test('ignores text-entry targets and non-card controls so native behavior is kept', () => {
    const dom = installDom();
    try {
      buildList(dom);
      const controller = setupMemoryKeyboard({ document: dom.document });

      const input = dom.document.getElementById('outside-filter') as HTMLInputElement;
      input.focus();
      const typing = press(dom, input, 'ArrowDown');
      expect(typing.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(input);

      // The view toggle owns Home/End and must not be hijacked by the list helper.
      const toggle = dom.document.querySelector('.view-toggle-btn') as HTMLElement;
      toggle.focus();
      const toggleKey = press(dom, toggle, 'Home');
      expect(toggleKey.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(toggle);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });

  test('is inert while the list view is hidden', () => {
    const dom = installDom();
    try {
      buildList(dom, { hidden: true });
      const controller = setupMemoryKeyboard({ document: dom.document });
      const first = links(dom)[0]!;

      // Even if a hidden card is focused programmatically, keys stay untouched.
      first.focus();
      const event = press(dom, first, 'ArrowDown');

      expect(event.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(first);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });

  test('Enter is left to the anchor so activation still opens the memory', () => {
    const dom = installDom();
    try {
      buildList(dom);
      const controller = setupMemoryKeyboard({ document: dom.document });
      const first = links(dom)[0]!;

      first.focus();
      const event = press(dom, first, 'Enter');

      expect(event.defaultPrevented).toBe(false);

      controller.destroy();
    } finally {
      dom.cleanup();
    }
  });
});
