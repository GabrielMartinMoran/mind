import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * Space title tag actions.
 *
 * Removable tags used to be click-only `<span>` elements. They are now native
 * `<button type="button">` controls with a decorative remove icon, so keyboard
 * users get Enter/Space activation and the same confirmation flow.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = {
  id: 'space-1',
  name: 'projects/mind',
  description: 'Mind project space',
  tags: ['type:project', 'cat:decision'],
  memory_count: 0,
  hidden: false,
};

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  dom: DomHarness;
  requests: RecordedRequest[];
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function bootApp(url: string, scenario: string): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const requests: RecordedRequest[] = [];

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);

    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ method, path, body });

    if (method === 'PATCH' && path === '/api/spaces/projects/mind') {
      return jsonResponse(SPACE);
    }
    if (path === '/api/spaces') return jsonResponse([SPACE]);
    if (path === '/api/status') {
      return jsonResponse({
        total_spaces: 1,
        total_memories: 0,
        by_tier: [
          { tier: 1, count: 0 },
          { tier: 2, count: 0 },
          { tier: 3, count: 0 },
        ],
        rag_enabled: false,
      });
    }
    if (path === '/api/memories/query') {
      return jsonResponse([], {
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '0' },
      });
    }
    if (path === '/api/search') {
      return jsonResponse([], {
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '0' },
      });
    }
    if (path === '/api/logs') return jsonResponse({ logs: [], total: 0, limit: 100, offset: 0 });
    if (/^\/api\/spaces\/.+\/graph$/.test(path)) return jsonResponse({ nodes: [], edges: [] });
    if (/^\/api\/spaces\/.+\/tags$/.test(path)) return jsonResponse([]);

    const spaceMatch = path.match(/^\/api\/spaces\/(.+)$/);
    if (spaceMatch) return jsonResponse({ ...SPACE, name: spaceMatch[1] });

    return jsonResponse([]);
  };

  const previousFetch = Reflect.get(globalThis, 'fetch');
  const previousMarked = Reflect.get(globalThis, 'marked');
  const previousLocation = Reflect.get(globalThis, 'location');
  const previousHistory = Reflect.get(globalThis, 'history');

  Reflect.set(globalThis, 'fetch', fetchMock);
  Reflect.set(globalThis, 'marked', { parse: (value: string) => value });
  Reflect.set(globalThis, 'location', dom.window.location);
  Reflect.set(globalThis, 'history', dom.window.history);

  const previousCleanup = dom.cleanup;
  dom.cleanup = () => {
    Reflect.set(globalThis, 'fetch', previousFetch);
    Reflect.set(globalThis, 'marked', previousMarked);
    Reflect.set(globalThis, 'location', previousLocation);
    Reflect.set(globalThis, 'history', previousHistory);
    previousCleanup();
  };

  await import(/* webpackIgnore: true */ `../src/app.js?space-tags=${scenario}`);

  return { dom, requests };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function click(dom: DomHarness, target: EventTarget): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    } as never) as never
  );
}

function pressKey(dom: DomHarness, target: Element, key: string): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    } as never) as never
  );
}

function isDialogOpen(dom: DomHarness, id: string): boolean {
  const dialog = dom.document.getElementById(id) as HTMLDialogElement | null;
  return dialog !== null && (dialog.open === true || dialog.hasAttribute('open'));
}

function iconHref(element: Element | null): string | null {
  return element?.querySelector('svg.icon use')?.getAttribute('href') ?? null;
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('space title tag actions', () => {
  test('removable tags are native named buttons with a decorative remove icon', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'semantics');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#space-tags-row .tag') !== null,
      'the space tag chips'
    );

    const chips = Array.from(
      dom.document.querySelectorAll<HTMLButtonElement>('#space-tags-row .tag')
    );
    expect(chips).toHaveLength(SPACE.tags.length);

    for (const chip of chips) {
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.type).toBe('button');
      const tag = chip.textContent?.replace('#', '').replace(/\s+/g, '');
      expect(chip.getAttribute('aria-label')).toMatch(/^Remove tag /);
      expect(chip.getAttribute('aria-label')).toContain(tag ?? '');
      expect(iconHref(chip)).toBe('/assets/icons.svg#icon-x');
      const icon = chip.querySelector('svg.icon');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.getAttribute('focusable')).toBe('false');
    }

    // No click-only span chips remain.
    expect(dom.document.querySelector('#space-tags-row span.tag')).toBeNull();

    const add = dom.document.querySelector<HTMLButtonElement>('#space-tags-row .tag-add');
    expect(add?.tagName).toBe('BUTTON');
    expect(add?.type).toBe('button');
    expect(add?.textContent).toContain('+ tag');
    expect(iconHref(add)).toBe('/assets/icons.svg#icon-tag');
  });

  test('activating a tag button (click and keyboard path) confirms then PATCHes removeTag once', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'keyboard');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#space-tags-row .tag') !== null,
      'the space tag chips'
    );

    const chip = dom.document.querySelector<HTMLButtonElement>('#space-tags-row .tag')!;
    expect(chip.textContent).toContain('#type:project');

    // Native buttons activate on Enter/Space; happy-dom does not synthesize the
    // click, so dispatch the activation click a browser generates for the key.
    chip.focus();
    expect(dom.document.activeElement).toBe(chip);
    pressKey(dom, chip, 'Enter');
    click(dom, chip);

    expect(isDialogOpen(dom, 'modal-delete')).toBe(true);

    click(dom, dom.document.getElementById('modal-delete-confirm')!);

    await waitFor(
      () => harness.requests.filter(r => r.method === 'PATCH').length === 1,
      'exactly one PATCH'
    );

    const patches = harness.requests.filter(r => r.method === 'PATCH');
    expect(patches[0]!.body).toEqual({ removeTag: 'type:project' });
  });

  test('the add-tag action is a button that reveals the inline input', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'add');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#space-tags-row .tag-add') !== null,
      'the add tag action'
    );

    const add = dom.document.querySelector<HTMLButtonElement>('#space-tags-row .tag-add')!;
    add.focus();
    pressKey(dom, add, 'Enter');
    click(dom, add);

    const row = dom.document.getElementById('space-tag-input-row')!;
    expect(row.classList.contains('hidden')).toBe(false);
    expect(dom.document.activeElement).toBe(dom.document.getElementById('space-tag-input'));
  });
});
