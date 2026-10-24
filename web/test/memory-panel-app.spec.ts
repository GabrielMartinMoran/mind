import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the memory panel dialog.
 *
 * These boot the real `web/src/app.js` against the real shell markup with a
 * deterministic `fetch` mock. They cover the seam the pure view tests cannot:
 * opening from a card or a deep link, focus entry/return, URL sync, the
 * loading/error/retry states, the edit/pin/promote/demote/tag mutations and
 * the rapid-selection race. The mock resolves synchronously unless a test
 * installs an explicit gate, and waits poll for DOM state instead of sleeping.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = 'projects/mind';
const MEMORY_BASE = `/api/spaces/${SPACE}/memories`;

interface MemoryItem {
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: 1 | 2 | 3;
  pinned: boolean;
  tags: string[];
  changed_at: string;
}

interface PatchCall {
  pathname: string;
  method: string;
  body: Record<string, unknown>;
}

interface Harness {
  dom: DomHarness;
  queryRequests: URL[];
  detailRequests: string[];
  patchCalls: PatchCall[];
  /** Release the gate installed for a detail request name. */
  releaseDetail: (name: string) => void;
}

interface HarnessOptions {
  searchResults?: unknown[];
  /** Hold the detail response for these names until `releaseDetail` is called. */
  gatedDetails?: string[];
  /** Fail the first detail request once with a 500. */
  failFirstDetail?: boolean;
}

function seedMemories(): Map<string, MemoryItem> {
  const items: MemoryItem[] = [
    {
      id: 'id-000',
      space_name: SPACE,
      name: 'memory-000',
      content: 'T1 content for memory 000',
      tier: 1,
      pinned: false,
      tags: ['cat:decision'],
      changed_at: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 'id-001',
      space_name: SPACE,
      name: 'memory-001',
      content: 'Original content for memory 001',
      tier: 2,
      pinned: false,
      tags: ['cat:decision', 'status:living'],
      changed_at: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 'id-002',
      space_name: SPACE,
      name: 'memory-002',
      content: 'T3 content for memory 002',
      tier: 3,
      pinned: false,
      tags: [],
      changed_at: '2026-10-20T10:00:00.000Z',
    },
  ];
  return new Map(items.map(item => [item.name, item]));
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function statusPayload() {
  return {
    total_spaces: 1,
    total_memories: 3,
    by_tier: [
      { tier: 1, count: 1 },
      { tier: 2, count: 1 },
      { tier: 3, count: 1 },
    ],
    rag_enabled: false,
  };
}

/** Install a fresh DOM + fetch mock and boot the real app module. */
async function bootApp(
  url: string,
  scenario: string,
  options: HarnessOptions = {}
): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const memories = seedMemories();
  const queryRequests: URL[] = [];
  const detailRequests: string[] = [];
  const patchCalls: PatchCall[] = [];
  let failNextDetail = options.failFirstDetail === true;

  const gateReleases = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  for (const name of options.gatedDetails ?? []) {
    gates.set(
      name,
      new Promise<void>(resolve => {
        gateReleases.set(name, resolve);
      })
    );
  }

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);
    const method = init?.method ?? 'GET';

    if (requestUrl.pathname === '/api/search') {
      const results = options.searchResults ?? [];
      return jsonResponse(results, {
        'X-Total-Count': String(results.length),
        'X-Has-More': 'false',
      });
    }

    if (requestUrl.pathname === '/api/memories/query') {
      queryRequests.push(requestUrl);
      const limit = Number(requestUrl.searchParams.get('limit') ?? 100);
      const offset = Number(requestUrl.searchParams.get('offset') ?? 0);
      const requestedTier = Number(requestUrl.searchParams.get('tier') ?? 0);
      const all = Array.from(memories.values());
      const filtered = requestedTier ? all.filter(item => item.tier === requestedTier) : all;
      const page = filtered.slice(offset, offset + limit);
      return jsonResponse(page, { 'X-Total-Count': String(filtered.length) });
    }

    if (path === '/api/spaces') {
      return jsonResponse([
        {
          id: 'space-1',
          name: SPACE,
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: 3,
          hidden: false,
        },
      ]);
    }

    if (path === '/api/status') {
      return jsonResponse(statusPayload());
    }

    if (path === `/api/spaces/${SPACE}`) {
      return jsonResponse({
        id: 'space-1',
        name: SPACE,
        description: 'Mind project space',
        tags: ['type:project'],
        hidden: false,
      });
    }

    if (path === `/api/spaces/${SPACE}/graph`) {
      return jsonResponse({ nodes: [], edges: [] });
    }

    if (path === `/api/spaces/${SPACE}/tags`) {
      const tags = [...new Set([...memories.values()].flatMap(memory => memory.tags))].sort();
      return jsonResponse(tags);
    }

    if (path.startsWith(`${MEMORY_BASE}/`)) {
      const name = path.slice(`${MEMORY_BASE}/`.length);

      if (method === 'PATCH') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        patchCalls.push({ pathname: path, method, body });
        const memory = memories.get(name);
        if (!memory) return jsonResponse({ error: 'Memory not found' }, {});
        if (typeof body.content === 'string') memory.content = body.content;
        if (typeof body.pinned === 'boolean') memory.pinned = body.pinned;
        if (body.promote === true) memory.tier = Math.max(1, memory.tier - 1) as 1 | 2 | 3;
        if (body.demote === true) memory.tier = Math.min(3, memory.tier + 1) as 1 | 2 | 3;
        if (typeof body.addTag === 'string') memory.tags = [...memory.tags, body.addTag];
        if (typeof body.removeTag === 'string') {
          memory.tags = memory.tags.filter(tag => tag !== body.removeTag);
        }
        return jsonResponse({ ...memory });
      }

      detailRequests.push(name);
      const gate = gates.get(name);
      if (gate) await gate;
      if (failNextDetail) {
        failNextDetail = false;
        return new Response(JSON.stringify({ error: 'Memory detail failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const memory = memories.get(name);
      if (!memory) return jsonResponse({ error: 'Memory not found' }, {});
      return jsonResponse({ ...memory });
    }

    if (path === MEMORY_BASE) {
      return jsonResponse([]);
    }

    return jsonResponse([]);
  };

  const previousFetch = Reflect.get(globalThis, 'fetch');
  const previousMarked = Reflect.get(globalThis, 'marked');
  const previousLocation = Reflect.get(globalThis, 'location');
  const previousHistory = Reflect.get(globalThis, 'history');
  const previousPrompt = Reflect.get(globalThis, 'prompt');
  const previousConfirm = Reflect.get(globalThis, 'confirm');
  Reflect.set(globalThis, 'fetch', fetchMock);
  Reflect.set(globalThis, 'marked', { parse: (value: string) => value });
  Reflect.set(globalThis, 'location', dom.window.location);
  Reflect.set(globalThis, 'history', dom.window.history);
  // The app must never fall back to a native prompt/confirm for panel actions.
  Reflect.set(globalThis, 'prompt', () => {
    throw new Error('native prompt must not be used');
  });
  Reflect.set(globalThis, 'confirm', () => {
    throw new Error('native confirm must not be used');
  });

  const previousCleanup = dom.cleanup;
  dom.cleanup = () => {
    Reflect.set(globalThis, 'fetch', previousFetch);
    Reflect.set(globalThis, 'marked', previousMarked);
    Reflect.set(globalThis, 'location', previousLocation);
    Reflect.set(globalThis, 'history', previousHistory);
    Reflect.set(globalThis, 'prompt', previousPrompt);
    Reflect.set(globalThis, 'confirm', previousConfirm);
    previousCleanup();
  };

  await import(/* webpackIgnore: true */ `../src/app.js?memory-panel=${scenario}`);

  return {
    dom,
    queryRequests,
    detailRequests,
    patchCalls,
    releaseDetail: name => gateReleases.get(name)?.(),
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Drain pending promise continuations without a fixed sleep. */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
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

function pressKey(dom: DomHarness, target: Element, key: string): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    } as never) as never
  );
}

function panel(dom: DomHarness): HTMLDialogElement | null {
  return dom.document.getElementById('memory-panel') as HTMLDialogElement | null;
}

/** The panel controller owns native dialog semantics; detect `open` either way. */
function isPanelOpen(dom: DomHarness): boolean {
  const dialog = panel(dom);
  return dialog !== null && (dialog.open === true || dialog.hasAttribute('open'));
}

function card(dom: DomHarness, name: string): HTMLElement | null {
  return dom.document.querySelector<HTMLElement>(`.memory-card[data-memory-name="${name}"]`);
}

function cardLink(dom: DomHarness, name: string): HTMLAnchorElement | null {
  return card(dom, name)?.querySelector('a.memory-card-link') ?? null;
}

function memTitle(dom: DomHarness): string | null {
  return dom.document.getElementById('mem-title')?.textContent ?? null;
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('memory panel app wiring', () => {
  test('opens a memory card as a modal dialog, moves focus inside and adds memory to the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'open-card');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');

    const link = cardLink(dom, 'memory-001')!;
    click(dom, link);

    await waitFor(
      () => isPanelOpen(dom) && memTitle(dom) === 'memory-001',
      'the panel to open and render memory-001'
    );

    const dialog = panel(dom)!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('mem-title');
    expect(dialog.contains(dom.document.activeElement)).toBe(true);
    expect(new URL(dom.window.location.href).searchParams.get('memory')).toBe('memory-001');
    expect(harness.patchCalls).toHaveLength(0);
  });

  test('closing via the close button returns focus to the card and keeps q on the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}?q=auth`, 'close-search', {
      searchResults: [
        {
          id: 'id-001',
          space_name: SPACE,
          name: 'memory-001',
          content: 'Auth content',
          tier: 2,
          pinned: false,
          tags: [],
          changed_at: '2026-10-20T10:00:00.000Z',
          score: 1,
          confidence: 'high',
          methods: ['fts5'],
        },
      ],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#space-search-view a.search-result-link') !== null,
      'the search result card'
    );
    const resultLink = dom.document.querySelector(
      '#space-search-view a.search-result-link'
    ) as HTMLElement;
    click(dom, resultLink);

    await waitFor(
      () => isPanelOpen(dom) && memTitle(dom) === 'memory-001',
      'the panel to open over the search result'
    );
    expect(new URL(dom.window.location.href).searchParams.get('q')).toBe('auth');

    const closeButton = dom.document.getElementById('btn-mem-close-inline') as HTMLElement;
    click(dom, closeButton);

    await waitFor(() => isPanelOpen(dom) === false, 'the panel to close');

    const url = new URL(dom.window.location.href);
    expect(url.searchParams.get('q')).toBe('auth');
    expect(url.searchParams.has('memory')).toBe(false);
    expect(dom.document.activeElement).toBe(resultLink);
  });

  test('Escape closes the panel, keeps the tier filter in the URL and returns focus to the card', async () => {
    const harness = await bootApp(
      `/spaces/${encodeURIComponent(SPACE)}?tier=1`,
      'close-escape-filters'
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-000') !== null, 'the T1 memory card');
    const link = cardLink(dom, 'memory-000')!;
    click(dom, link);

    await waitFor(
      () => isPanelOpen(dom) && memTitle(dom) === 'memory-000',
      'the panel to open for memory-000'
    );

    pressEscape(dom);

    await waitFor(() => isPanelOpen(dom) === false, 'the panel to close on Escape');
    const url = new URL(dom.window.location.href);
    expect(url.searchParams.get('tier')).toBe('1');
    expect(url.searchParams.has('memory')).toBe(false);
    expect(dom.document.activeElement).toBe(link);
  });

  test('clicking the backdrop closes the panel and drops memory from the URL', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'close-backdrop');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);

    await waitFor(() => isPanelOpen(dom) && memTitle(dom) === 'memory-001', 'the panel to open');

    click(dom, panel(dom)!);

    await waitFor(() => isPanelOpen(dom) === false, 'the panel to close on backdrop click');
    expect(new URL(dom.window.location.href).searchParams.has('memory')).toBe(false);
  });

  test('a ?memory= deep link opens the panel and moves focus inside via the fallback target', async () => {
    const harness = await bootApp(
      `/spaces/${encodeURIComponent(SPACE)}?memory=memory-001`,
      'deep-link'
    );
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => isPanelOpen(dom) && memTitle(dom) === 'memory-001',
      'the deep-linked panel to open'
    );

    const dialog = panel(dom)!;
    // No visible card can be the return target on a direct deep link, so the
    // fallback close button receives focus and stays inside the dialog.
    const fallback = dom.document.getElementById('btn-mem-close-inline') as HTMLElement;
    expect(dialog.contains(dom.document.activeElement)).toBe(true);
    expect(dom.document.activeElement).toBe(fallback);
    expect(dom.document.getElementById('mem-content')?.textContent).toContain('Original content');
  });

  test('shows the loading skeleton while the detail request is in flight', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'loading', {
      gatedDetails: ['memory-001'],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);

    await waitFor(() => isPanelOpen(dom), 'the panel to open in loading state');

    const dialog = panel(dom)!;
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    const state = dom.document.getElementById('mem-state')!;
    expect(state.querySelector('.mem-skeleton')).not.toBeNull();
    expect(dom.document.getElementById('mem-content')?.classList.contains('hidden')).toBe(true);

    harness.releaseDetail('memory-001');
    await waitFor(
      () => dom.document.getElementById('mem-content')?.textContent?.includes('Original content'),
      'the loaded memory content'
    );
  });

  test('shows the error state and retries the detail request', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'error-retry', {
      failFirstDetail: true,
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);

    const state = await (async () => {
      await waitFor(
        () => dom.document.querySelector('#mem-state[role="alert"]') !== null,
        'the panel error state'
      );
      return dom.document.getElementById('mem-state')!;
    })();

    expect(state.textContent).toContain('Memory detail failed');
    expect(state.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(harness.detailRequests).toEqual(['memory-001']);

    click(dom, state.querySelector('[data-action="retry"]')!);

    await waitFor(
      () => dom.document.getElementById('mem-content')?.textContent?.includes('Original content'),
      'the retried memory content'
    );
    expect(harness.detailRequests).toEqual(['memory-001', 'memory-001']);
    expect(harness.patchCalls).toHaveLength(0);
  });

  test('saving an edit PATCHes once and shows the updated content; cancelling restores it', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'edit-save');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);
    await waitFor(() => memTitle(dom) === 'memory-001', 'the panel to render');

    // Enter edit mode, change the text, then save.
    click(dom, dom.document.getElementById('btn-mem-edit')!);
    const area = dom.document.getElementById('mem-edit-area')!;
    const input = dom.document.getElementById('mem-edit-input') as HTMLTextAreaElement;
    expect(area.classList.contains('hidden')).toBe(false);
    expect(input.value).toBe('Original content for memory 001');
    input.value = 'Updated content for memory 001';
    click(dom, dom.document.getElementById('btn-mem-save')!);

    await waitFor(
      () => dom.document.getElementById('mem-content')?.textContent?.includes('Updated content'),
      'the panel to show the saved content'
    );
    expect(harness.patchCalls).toHaveLength(1);
    expect(harness.patchCalls[0]!.body).toEqual({ content: 'Updated content for memory 001' });
    expect(area.classList.contains('hidden')).toBe(true);

    // Cancel discards the draft and restores the last-rendered content.
    click(dom, dom.document.getElementById('btn-mem-edit')!);
    input.value = 'Discarded draft';
    click(dom, dom.document.getElementById('btn-mem-cancel-edit')!);
    expect(area.classList.contains('hidden')).toBe(true);
    expect(dom.document.getElementById('mem-content')?.textContent).toContain('Updated content');
    expect(dom.document.getElementById('mem-content')?.textContent).not.toContain(
      'Discarded draft'
    );
    expect(harness.patchCalls).toHaveLength(1);
  });

  test('pin, promote and demote PATCH once each and update the panel', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'actions-tier');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);
    await waitFor(() => memTitle(dom) === 'memory-001', 'the panel to render');

    const pin = dom.document.getElementById('btn-mem-pin') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    click(dom, pin);
    await waitFor(() => pin.getAttribute('aria-pressed') === 'true', 'the pin to apply');
    expect(harness.patchCalls).toHaveLength(1);
    expect(harness.patchCalls[0]!.body).toEqual({ pinned: true });

    click(dom, dom.document.getElementById('btn-mem-promote')!);
    await waitFor(
      () => dom.document.getElementById('mem-tier-badge')?.textContent === 'T1',
      'the promote to apply'
    );
    expect(harness.patchCalls).toHaveLength(2);
    expect(harness.patchCalls[1]!.body).toEqual({ promote: true });

    click(dom, dom.document.getElementById('btn-mem-demote')!);
    await waitFor(
      () => dom.document.getElementById('mem-tier-badge')?.textContent === 'T2',
      'the demote to apply'
    );
    expect(harness.patchCalls).toHaveLength(3);
    expect(harness.patchCalls[2]!.body).toEqual({ demote: true });

    // The list card reflects the tier change without a second dispatch.
    expect(card(dom, 'memory-001')?.querySelector('.memory-card-tier')?.textContent).toBe('T2');
  });

  test('adding and removing a tag PATCHes once each and updates the tag row', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'actions-tags');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => card(dom, 'memory-001') !== null, 'the memory card');
    click(dom, cardLink(dom, 'memory-001')!);
    await waitFor(() => memTitle(dom) === 'memory-001', 'the panel to render');

    const addTrigger = dom.document.querySelector<HTMLElement>(
      '#mem-tags-row [data-action="add-tag"]'
    )!;
    click(dom, addTrigger);

    // The inline input is revealed and focused instead of a native prompt.
    const tagInput = dom.document.getElementById('mem-tag-input') as HTMLInputElement;
    const tagRow = dom.document.getElementById('mem-tag-input-row')!;
    expect(tagRow.classList.contains('hidden')).toBe(false);
    expect(dom.document.activeElement).toBe(tagInput);

    tagInput.value = 'cat:new-tag';
    pressKey(dom, tagInput, 'Enter');
    await waitFor(
      () =>
        dom.document.querySelector(
          '#mem-tags-row [data-action="remove-tag"][data-tag="cat:new-tag"]'
        ) !== null,
      'the added tag chip'
    );
    expect(harness.patchCalls).toHaveLength(1);
    expect(harness.patchCalls[0]!.body).toEqual({ addTag: 'cat:new-tag' });
    // Committing hides the inline input again.
    expect(tagRow.classList.contains('hidden')).toBe(true);

    const tagSelect = dom.document.getElementById('space-filter-tag') as HTMLSelectElement;
    await waitFor(
      () => Array.from(tagSelect.options).some(option => option.value === 'cat:new-tag'),
      'the added memory tag option'
    );

    click(
      dom,
      dom.document.querySelector(
        '#mem-tags-row [data-action="remove-tag"][data-tag="cat:new-tag"]'
      )!
    );
    await waitFor(
      () =>
        dom.document.querySelector(
          '#mem-tags-row [data-action="remove-tag"][data-tag="cat:new-tag"]'
        ) === null,
      'the removed tag chip'
    );
    expect(harness.patchCalls).toHaveLength(2);
    expect(harness.patchCalls[1]!.body).toEqual({ removeTag: 'cat:new-tag' });
    await waitFor(
      () => !Array.from(tagSelect.options).some(option => option.value === 'cat:new-tag'),
      'the removed memory tag option'
    );
  });

  test('rapid selection ignores the slower earlier response and shows the latest', async () => {
    const harness = await bootApp(`/spaces/${encodeURIComponent(SPACE)}`, 'rapid-selection', {
      gatedDetails: ['memory-000'],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => card(dom, 'memory-000') !== null && card(dom, 'memory-001') !== null,
      'the memory cards'
    );

    // Open A (slow, gated), then B (fast) before A resolves.
    click(dom, cardLink(dom, 'memory-000')!);
    await waitFor(() => isPanelOpen(dom), 'the panel to open for memory A');
    click(dom, cardLink(dom, 'memory-001')!);

    await waitFor(() => memTitle(dom) === 'memory-001', 'memory B to render');

    // Release A's response; the request-id guard must discard it.
    harness.releaseDetail('memory-000');
    await flushMicrotasks();

    expect(memTitle(dom)).toBe('memory-001');
    expect(dom.document.getElementById('mem-content')?.textContent).toContain('Original content');
    expect(new URL(dom.window.location.href).searchParams.get('memory')).toBe('memory-001');
  });
});
