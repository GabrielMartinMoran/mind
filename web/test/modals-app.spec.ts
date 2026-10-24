import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the accessible create modals.
 *
 * These tests boot the real `web/src/app.js` against the real shell markup with
 * a mocked `fetch`, so they cover the seam the modal/forms unit tests cannot:
 * the trigger opens the native dialog, validation blocks the request, a valid
 * submit POSTs the right body and refreshes the backing data, and an API error
 * is announced without losing the typed values. The mock resolves
 * synchronously and waits poll for DOM state instead of sleeping.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');

const SPACE = {
  id: 'space-1',
  name: 'projects/mind',
  description: 'Mind project space',
  tags: ['type:project'],
  memory_count: 1,
  hidden: false,
};

const MEMORY = {
  id: 'mem-1',
  space_name: 'projects/mind',
  name: 'disposable-memory',
  content: 'A disposable memory body.',
  tier: 2,
  pinned: false,
  tags: ['cat:decision'],
  changed_at: '2026-10-21T00:00:00.000Z',
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

interface MockConfig {
  spacePostStatus?: number;
  memoryPostStatus?: number;
  spaceDeleteStatus?: number;
  memoryDeleteStatus?: number;
  spacePatchStatus?: number;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function statusPayload() {
  return {
    total_spaces: 1,
    total_memories: 1,
    by_tier: [
      { tier: 1, count: 0 },
      { tier: 2, count: 1 },
      { tier: 3, count: 0 },
    ],
    rag_enabled: false,
  };
}

/** Build the shell DOM, install a `fetch` mock and boot the real app module. */
async function bootApp(url: string, scenario: string, config: MockConfig = {}): Promise<Harness> {
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

    if (method === 'POST' && path === '/api/spaces') {
      const status = config.spacePostStatus ?? 201;
      if (status >= 400) return jsonResponse({ error: 'name already exists' }, { status });
      return jsonResponse(SPACE, { status });
    }

    if (method === 'POST' && path === '/api/spaces/projects/mind/memories') {
      const status = config.memoryPostStatus ?? 201;
      if (status >= 400) return jsonResponse({ error: 'duplicate memory' }, { status });
      const input = (body ?? {}) as Record<string, unknown>;
      return jsonResponse(
        {
          id: 'm1',
          space_name: 'projects/mind',
          name: input.name ?? '',
          content: input.content ?? '',
          tier: input.tier ?? 2,
          pinned: false,
          tags: input.tags ?? [],
          changed_at: '2026-10-21T00:00:00.000Z',
        },
        { status }
      );
    }

    if (method === 'DELETE' && path === '/api/spaces/projects/mind') {
      const status = config.spaceDeleteStatus ?? 200;
      if (status >= 400) return jsonResponse({ error: 'space cannot be deleted' }, { status });
      return jsonResponse({ ok: true }, { status });
    }

    if (method === 'DELETE' && path === `/api/spaces/projects/mind/memories/${MEMORY.name}`) {
      const status = config.memoryDeleteStatus ?? 200;
      if (status >= 400) return jsonResponse({ error: 'memory cannot be deleted' }, { status });
      return jsonResponse({ ok: true }, { status });
    }

    if (method === 'PATCH' && path === '/api/spaces/projects/mind') {
      const status = config.spacePatchStatus ?? 200;
      if (status >= 400) return jsonResponse({ error: 'tag update failed' }, { status });
      return jsonResponse(SPACE, { status });
    }

    if (method === 'PATCH' && path === `/api/spaces/projects/mind/memories/${MEMORY.name}`) {
      const input = (body ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(input.addTag)
        ? input.addTag
        : typeof input.addTag === 'string'
          ? [...MEMORY.tags, input.addTag]
          : MEMORY.tags;
      return jsonResponse({ ...MEMORY, tags });
    }

    const graphMatch = path.match(/^\/api\/spaces\/(.+)\/graph$/);
    if (graphMatch) return jsonResponse({ nodes: [], edges: [] });

    const memoryDetailMatch = path.match(/^\/api\/spaces\/(.+)\/memories\/(.+)$/);
    if (memoryDetailMatch) {
      return jsonResponse({ ...MEMORY, name: memoryDetailMatch[2] });
    }

    if (path === '/api/spaces') return jsonResponse([SPACE]);
    if (path === '/api/status') return jsonResponse(statusPayload());
    if (path === '/api/memories/query') {
      return jsonResponse([MEMORY], {
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '1' },
      });
    }
    if (path === '/api/search') {
      return jsonResponse([], {
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '0' },
      });
    }
    if (path === '/api/logs') {
      return jsonResponse({ logs: [], total: 0, limit: 100, offset: 0 });
    }

    const spaceMatch = path.match(/^\/api\/spaces\/(.+)$/);
    if (spaceMatch) return jsonResponse({ ...SPACE, name: spaceMatch[1] });

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
  // Native dialogs must be fully replaced: any call is a test failure.
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

  await import(/* webpackIgnore: true */ `../src/app.js?modals=${scenario}`);

  return { dom, requests };
}

/** Poll for a DOM condition with a bounded timeout; never a fixed sleep. */
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

function pressEscape(dom: DomHarness): void {
  dom.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    } as never) as never
  );
}

function isDialogOpen(dom: DomHarness, id: string): boolean {
  const dialog = dom.document.getElementById(id) as HTMLDialogElement | null;
  return dialog !== null && (dialog.open === true || dialog.hasAttribute('open'));
}

function byId<T extends Element>(dom: DomHarness, id: string): T {
  const node = dom.document.getElementById(id);
  if (!node) throw new Error(`#${id} not found`);
  return node as unknown as T;
}

function setValue(
  dom: DomHarness,
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  element.value = value;
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as never);
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

function cardLink(dom: DomHarness, name: string): HTMLAnchorElement | null {
  return dom.document.querySelector<HTMLAnchorElement>(
    `.memory-card[data-memory-name="${name}"] a.memory-card-link`
  );
}

function requestsFor(harness: Harness, method: string, path: string): RecordedRequest[] {
  return harness.requests.filter(r => r.method === method && r.path === path);
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('create modal app wiring', () => {
  test('New space opens, focuses the first field, and Escape closes returning focus', async () => {
    const harness = await bootApp('/', 'open-escape');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    const trigger = byId<HTMLButtonElement>(dom, 'btn-new-space');
    trigger.focus();
    click(dom, trigger);

    expect(isDialogOpen(dom, 'modal-new-space')).toBe(true);
    expect(dom.document.activeElement).toBe(byId(dom, 'new-space-name'));

    pressEscape(dom);

    expect(isDialogOpen(dom, 'modal-new-space')).toBe(false);
    expect(dom.document.activeElement).toBe(trigger);
  });

  test('a modal can be reopened after Escape', async () => {
    const harness = await bootApp('/', 'reopen');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    const trigger = byId<HTMLButtonElement>(dom, 'btn-new-space');
    click(dom, trigger);
    pressEscape(dom);
    expect(isDialogOpen(dom, 'modal-new-space')).toBe(false);

    click(dom, trigger);

    expect(isDialogOpen(dom, 'modal-new-space')).toBe(true);
    expect(dom.document.activeElement).toBe(byId(dom, 'new-space-name'));
  });

  test('submitting an empty space name shows an inline error, stays open and sends no request', async () => {
    const harness = await bootApp('/', 'space-empty-name');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    click(dom, byId(dom, 'btn-new-space'));
    click(dom, byId(dom, 'modal-space-create'));

    await waitFor(
      () =>
        byId(dom, 'modal-new-space').querySelector('[data-field-error-for="name"]')?.textContent !==
        '',
      'the inline name error'
    );

    expect(isDialogOpen(dom, 'modal-new-space')).toBe(true);
    expect(harness.requests.some(r => r.method === 'POST' && r.path === '/api/spaces')).toBe(false);
  });

  test('a valid space submit POSTs the body, closes the dialog and refreshes spaces', async () => {
    const harness = await bootApp('/', 'space-create');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    click(dom, byId(dom, 'btn-new-space'));
    setValue(dom, byId<HTMLInputElement>(dom, 'new-space-name'), 'fresh-space');
    setValue(dom, byId<HTMLInputElement>(dom, 'new-space-desc'), 'A brand new space');
    setValue(dom, byId<HTMLInputElement>(dom, 'new-space-tags'), 'Alpha, beta');
    click(dom, byId(dom, 'modal-space-create'));

    await waitFor(() => !isDialogOpen(dom, 'modal-new-space'), 'the space dialog to close');

    const post = harness.requests.find(r => r.method === 'POST' && r.path === '/api/spaces');
    expect(post).toBeDefined();
    expect(post!.body).toEqual({
      name: 'fresh-space',
      description: 'A brand new space',
      tags: ['alpha', 'beta'],
    });

    // The spaces were refreshed (the list request ran again after the POST).
    const getSpaces = harness.requests.filter(r => r.method === 'GET' && r.path === '/api/spaces');
    expect(getSpaces.length).toBeGreaterThanOrEqual(2);
  });

  test('a space API error is announced in the dialog and preserves the entered values', async () => {
    const harness = await bootApp('/', 'space-error', { spacePostStatus: 400 });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    click(dom, byId(dom, 'btn-new-space'));
    const name = byId<HTMLInputElement>(dom, 'new-space-name');
    setValue(dom, name, 'taken-space');
    click(dom, byId(dom, 'modal-space-create'));

    const errorRegion = () =>
      byId(dom, 'modal-new-space').querySelector<HTMLElement>('[data-modal-error]');
    await waitFor(() => errorRegion()?.textContent !== '', 'the API error message');

    expect(isDialogOpen(dom, 'modal-new-space')).toBe(true);
    expect(errorRegion()!.hasAttribute('hidden')).toBe(false);
    expect(errorRegion()!.textContent).toContain('name already exists');
    expect(name.value).toBe('taken-space');
  });

  test('New memory opens from a space, POSTs the body and refreshes the list', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'memory-create');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );

    const queriesBefore = harness.requests.filter(
      r => r.method === 'GET' && r.path === '/api/memories/query'
    ).length;

    const trigger = byId<HTMLButtonElement>(dom, 'btn-add-memory');
    trigger.focus();
    click(dom, trigger);

    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(true);
    expect(dom.document.activeElement).toBe(byId(dom, 'new-mem-name'));

    setValue(dom, byId<HTMLInputElement>(dom, 'new-mem-name'), 'new-memory');
    setValue(dom, byId<HTMLTextAreaElement>(dom, 'new-mem-content'), 'The memory body.');
    setValue(dom, byId<HTMLInputElement>(dom, 'new-mem-tags'), 'cat:decision');
    setValue(dom, byId<HTMLSelectElement>(dom, 'new-mem-tier'), '1');
    click(dom, byId(dom, 'modal-mem-create'));

    await waitFor(() => !isDialogOpen(dom, 'modal-new-memory'), 'the memory dialog to close');

    const post = harness.requests.find(
      r => r.method === 'POST' && r.path === '/api/spaces/projects/mind/memories'
    );
    expect(post).toBeDefined();
    expect(post!.body).toEqual({
      name: 'new-memory',
      content: 'The memory body.',
      tags: ['cat:decision'],
      tier: 1,
    });

    await waitFor(
      () =>
        harness.requests.filter(r => r.method === 'GET' && r.path === '/api/memories/query')
          .length > queriesBefore,
      'the memory list to refresh'
    );
  });

  test('a memory API error is announced and keeps the entered values', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'memory-error', {
      memoryPostStatus: 400,
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );

    click(dom, byId(dom, 'btn-add-memory'));
    const name = byId<HTMLInputElement>(dom, 'new-mem-name');
    const content = byId<HTMLTextAreaElement>(dom, 'new-mem-content');
    setValue(dom, name, 'dup-memory');
    setValue(dom, content, 'Keep this body.');
    click(dom, byId(dom, 'modal-mem-create'));

    const errorRegion = () =>
      byId(dom, 'modal-new-memory').querySelector<HTMLElement>('[data-modal-error]');
    await waitFor(() => errorRegion()?.textContent !== '', 'the memory API error message');

    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(true);
    expect(errorRegion()!.textContent).toContain('duplicate memory');
    expect(name.value).toBe('dup-memory');
    expect(content.value).toBe('Keep this body.');
  });
});

describe('delete confirmation and inline tag app wiring', () => {
  test('#home-create-space opens the space dialog and its cancel closes with no POST', async () => {
    const harness = await bootApp('/', 'home-create-cancel');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => (dom.document.getElementById('home-spaces')?.children.length ?? 0) === 1,
      'the home atlas to render'
    );

    click(dom, byId(dom, 'home-create-space'));
    expect(isDialogOpen(dom, 'modal-new-space')).toBe(true);

    click(dom, byId(dom, 'modal-space-cancel'));
    expect(isDialogOpen(dom, 'modal-new-space')).toBe(false);
    expect(harness.requests.some(r => r.method === 'POST')).toBe(false);
  });

  test('#modal-mem-cancel closes the memory dialog without a POST', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'memory-cancel');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );

    const trigger = byId<HTMLButtonElement>(dom, 'btn-add-memory');
    trigger.focus();
    click(dom, trigger);
    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(true);

    click(dom, byId(dom, 'modal-mem-cancel'));
    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(false);
    expect(dom.document.activeElement).toBe(trigger);
    expect(harness.requests.some(r => r.method === 'POST')).toBe(false);
  });

  test('New memory Escape closes and returns focus to the relocated identity trigger', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'memory-escape');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );

    const trigger = byId<HTMLButtonElement>(dom, 'btn-add-memory');
    expect(trigger.closest('.space-identity')).not.toBeNull();

    trigger.focus();
    click(dom, trigger);
    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(true);
    expect(dom.document.activeElement).toBe(byId(dom, 'new-mem-name'));

    pressEscape(dom);

    expect(isDialogOpen(dom, 'modal-new-memory')).toBe(false);
    expect(dom.document.activeElement).toBe(trigger);
  });

  test('deleting a memory confirms, cancels without a DELETE, then deletes once and refreshes', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'delete-memory');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cardLink(dom, 'disposable-memory') !== null, 'the memory card');
    click(dom, cardLink(dom, 'disposable-memory')!);
    await waitFor(
      () =>
        isPanelOpen(dom) &&
        dom.document.getElementById('mem-title')?.textContent === 'disposable-memory',
      'the memory panel'
    );

    click(dom, byId(dom, 'btn-mem-delete'));
    expect(isDialogOpen(dom, 'modal-delete')).toBe(true);

    click(dom, byId(dom, 'modal-delete-cancel'));
    expect(isDialogOpen(dom, 'modal-delete')).toBe(false);
    expect(harness.requests.some(r => r.method === 'DELETE')).toBe(false);
    expect(isPanelOpen(dom)).toBe(true);

    const queriesBefore = requestsFor(harness, 'GET', '/api/memories/query').length;

    click(dom, byId(dom, 'btn-mem-delete'));
    click(dom, byId(dom, 'modal-delete-confirm'));

    await waitFor(
      () => harness.requests.filter(r => r.method === 'DELETE').length === 1,
      'exactly one DELETE'
    );
    await waitFor(() => isPanelOpen(dom) === false, 'the panel to close');

    const deletes = harness.requests.filter(r => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toBe('/api/spaces/projects/mind/memories/disposable-memory');

    await waitFor(
      () => requestsFor(harness, 'GET', '/api/memories/query').length > queriesBefore,
      'the memory list to refresh'
    );
  });

  test('deleting a space confirms, DELETEs exactly once and refreshes the spaces', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'delete-space');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );

    const spacesBefore = requestsFor(harness, 'GET', '/api/spaces').length;

    click(dom, byId(dom, 'btn-delete-space'));
    expect(isDialogOpen(dom, 'modal-delete')).toBe(true);
    click(dom, byId(dom, 'modal-delete-confirm'));

    await waitFor(
      () => harness.requests.filter(r => r.method === 'DELETE').length === 1,
      'exactly one DELETE'
    );

    const deletes = harness.requests.filter(r => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toBe('/api/spaces/projects/mind');

    await waitFor(
      () => requestsFor(harness, 'GET', '/api/spaces').length > spacesBefore,
      'the spaces to refresh'
    );
  });

  test('removing a space tag confirms then PATCHes removeTag exactly once', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'space-tag-remove');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to restore'
    );
    await waitFor(
      () => dom.document.querySelector('#space-tags-row button.tag') !== null,
      'the space tag chip'
    );

    const chip = dom.document.querySelector('#space-tags-row button.tag')!;
    expect(chip.getAttribute('aria-label')).toBe('Remove tag type:project');
    expect(chip.textContent).toBe('#type:project');

    click(dom, chip);
    expect(isDialogOpen(dom, 'modal-delete')).toBe(true);

    click(dom, byId(dom, 'modal-delete-confirm'));

    await waitFor(
      () => requestsFor(harness, 'PATCH', '/api/spaces/projects/mind').length === 1,
      'exactly one PATCH'
    );

    const patches = requestsFor(harness, 'PATCH', '/api/spaces/projects/mind');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ removeTag: 'type:project' });
  });

  test('a delete API error keeps the confirmation open and shows the message', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'delete-memory-error', {
      memoryDeleteStatus: 400,
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => cardLink(dom, 'disposable-memory') !== null, 'the memory card');
    click(dom, cardLink(dom, 'disposable-memory')!);
    await waitFor(
      () =>
        isPanelOpen(dom) &&
        dom.document.getElementById('mem-title')?.textContent === 'disposable-memory',
      'the memory panel'
    );

    click(dom, byId(dom, 'btn-mem-delete'));
    click(dom, byId(dom, 'modal-delete-confirm'));

    const errorRegion = () =>
      byId(dom, 'modal-delete').querySelector<HTMLElement>('[data-modal-error]');
    await waitFor(() => (errorRegion()?.textContent ?? '') !== '', 'the delete error message');

    expect(isDialogOpen(dom, 'modal-delete')).toBe(true);
    expect(errorRegion()!.textContent).toContain('memory cannot be deleted');
    expect(harness.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });

  test('inline tag add: Enter PATCHes addTag, Escape cancels, and no native prompt is used', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind', 'inline-tag-add');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;
    const memoryPath = '/api/spaces/projects/mind/memories/disposable-memory';

    await waitFor(() => cardLink(dom, 'disposable-memory') !== null, 'the memory card');
    click(dom, cardLink(dom, 'disposable-memory')!);
    await waitFor(
      () =>
        isPanelOpen(dom) &&
        dom.document.getElementById('mem-title')?.textContent === 'disposable-memory',
      'the memory panel'
    );

    const addTrigger = dom.document.querySelector<HTMLElement>(
      '#mem-tags-row [data-action="add-tag"]'
    )!;
    const tagInput = byId<HTMLInputElement>(dom, 'mem-tag-input');
    const tagRow = byId(dom, 'mem-tag-input-row');

    click(dom, addTrigger);
    expect(tagRow.classList.contains('hidden')).toBe(false);
    expect(dom.document.activeElement).toBe(tagInput);

    tagInput.value = 'cat:inline';
    pressKey(dom, tagInput, 'Enter');
    await waitFor(() => requestsFor(harness, 'PATCH', memoryPath).length === 1, 'the addTag PATCH');

    expect(requestsFor(harness, 'PATCH', memoryPath)[0]!.body).toEqual({ addTag: 'cat:inline' });
    expect(tagRow.classList.contains('hidden')).toBe(true);

    // Escape cancels the entry: the input hides and no second PATCH is sent.
    click(dom, addTrigger);
    tagInput.value = 'cat:cancelled';
    pressKey(dom, tagInput, 'Escape');
    expect(tagRow.classList.contains('hidden')).toBe(true);
    expect(requestsFor(harness, 'PATCH', memoryPath)).toHaveLength(1);
  });
});
