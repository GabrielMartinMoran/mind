import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, jest, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the logs page.
 *
 * These boot the real `web/src/app.js` against the real shell markup with a
 * deterministic `fetch` mock. They cover the seam the pure view/model suites
 * cannot: the first-page request, filters/pagination, the live polling
 * lifecycle (start/stop/pause/cap), the clear action and error/retry.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const appSource = readFileSync(join(import.meta.dir, '../src/app.js'), 'utf8');

interface LogItem {
  id: number;
  source: 'cli' | 'mcp' | 'api';
  operation: string;
  level: 'info' | 'warn' | 'error';
  input_data: string | null;
  output_data: string | null;
  error_message: string | null;
  caller_info: string | null;
  duration_ms: number | null;
  timestamp: string;
}

interface Harness {
  dom: DomHarness;
  logsRequests: URL[];
  deleteCalls: number;
}

interface HarnessOptions {
  total?: number;
  failFirst?: boolean;
  rowsPerPage?: number;
}

function logItem(index: number, overrides: Partial<LogItem> = {}): LogItem {
  return {
    id: index + 1,
    source: 'api',
    operation: `operation-${index}`,
    level: 'info',
    input_data: '{"q":"auth"}',
    output_data: '{"count":1}',
    error_message: null,
    caller_info: null,
    duration_ms: 5,
    timestamp: '2026-10-20 10:00:00',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function flushMicrotasks(rounds = 20): Promise<void> {
  return (async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  })();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Install a fresh DOM + fetch mock and boot the real app module at `/logs`. */
async function bootLogs(scenario: string, options: HarnessOptions = {}): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', '/logs');

  const total = options.total ?? 120;
  const rowsPerPage = options.rowsPerPage ?? 25;
  const logsRequests: URL[] = [];
  let deleteCalls = 0;
  let failFirst = options.failFirst === true;

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);
    const method = init?.method ?? 'GET';

    if (path === '/api/logs') {
      if (method === 'DELETE') {
        deleteCalls += 1;
        return jsonResponse({ deleted: total });
      }

      logsRequests.push(requestUrl);
      if (failFirst) {
        failFirst = false;
        return jsonResponse({ error: 'Logs failed' }, 500);
      }

      const limit = Math.max(
        rowsPerPage,
        Number(requestUrl.searchParams.get('limit') ?? rowsPerPage)
      );
      const offset = Number(requestUrl.searchParams.get('offset') ?? 0);
      const count = Math.max(0, Math.min(limit, total - offset));
      const logs = Array.from({ length: count }, (_, index) => logItem(offset + index));
      return jsonResponse({ logs, total, limit, offset });
    }

    if (path === '/api/spaces') {
      return jsonResponse([
        {
          id: 'space-1',
          name: 'projects/mind',
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: 0,
          hidden: false,
        },
      ]);
    }

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

  await import(/* webpackIgnore: true */ `../src/app.js?logs=${scenario}`);

  return {
    dom,
    logsRequests,
    // Expose a live getter: the mock mutates this counter after boot, so a
    // copied primitive would stay frozen at 0.
    get deleteCalls() {
      return deleteCalls;
    },
  };
}

function click(dom: DomHarness, target: Element): void {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  } as never);
  target.dispatchEvent(event as unknown as Event);
}

function change(dom: DomHarness, target: Element): void {
  target.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);
}

// Bun exposes Jest-compatible fake timers at runtime, but the bundled `Jest`
// type only declares the mock/system-time helpers. Keep one typed alias so the
// timer calls stay checked rather than sprinkling `any`.
const fakeTimers = jest as unknown as {
  useFakeTimers: () => void;
  useRealTimers: () => void;
  advanceTimersByTime: (ms: number) => void;
};

function rows(dom: DomHarness): Element[] {
  return Array.from(dom.document.querySelectorAll('.logs-row'));
}

function liveToggle(dom: DomHarness): HTMLInputElement {
  return dom.document.getElementById('logs-live-toggle') as HTMLInputElement;
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  try {
    fakeTimers.useRealTimers();
  } catch {
    // Fake timers were never installed.
  }
  cleanup?.();
  cleanup = null;
});

describe('logs page app wiring', () => {
  test('loads page 1 with limit/offset, renders rows and one labelled heading', async () => {
    const harness = await bootLogs('first-page');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    expect(harness.logsRequests).toHaveLength(1);
    const request = harness.logsRequests[0]!;
    expect(request.searchParams.get('limit')).toBe('25');
    expect(request.searchParams.get('offset')).toBe('0');

    expect(dom.document.querySelectorAll('#logs-page h1')).toHaveLength(1);
    expect(dom.document.getElementById('logs-heading')).not.toBeNull();
    const region = dom.document.querySelector('.logs-view') as HTMLElement;
    expect(region.getAttribute('aria-labelledby')).toBe('logs-heading');
    expect(dom.document.getElementById('logs-page')?.classList.contains('hidden')).toBe(false);
  });

  test('a filter change resets the offset, sends validated params and clear restores all', async () => {
    const harness = await bootLogs('filters');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    const source = dom.document.getElementById('log-filter-source') as HTMLSelectElement;
    source.value = 'cli';
    change(dom, source);

    await waitFor(() => harness.logsRequests.length === 2, 'the filtered request');
    const filtered = harness.logsRequests[1]!;
    expect(filtered.searchParams.get('source')).toBe('cli');
    expect(filtered.searchParams.get('offset')).toBe('0');

    click(dom, dom.document.getElementById('logs-clear-filters') as HTMLElement);

    await waitFor(() => harness.logsRequests.length === 3, 'the cleared request');
    const cleared = harness.logsRequests[2]!;
    expect(cleared.searchParams.has('source')).toBe(false);
    expect(cleared.searchParams.get('offset')).toBe('0');
  });

  test('paginates with the page offset', async () => {
    const harness = await bootLogs('pagination');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    click(dom, dom.document.getElementById('logs-page-next') as HTMLElement);

    await waitFor(() => harness.logsRequests.length === 2, 'the second page request');
    expect(harness.logsRequests[1]!.searchParams.get('offset')).toBe('25');
    expect(dom.document.getElementById('logs-status')?.textContent).toContain('26–50');
  });

  test('expands details without refetching', async () => {
    const harness = await bootLogs('details');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    click(dom, dom.document.querySelector('.logs-details-toggle') as HTMLElement);
    await flushMicrotasks();

    expect(dom.document.querySelector('.logs-details-row')).not.toBeNull();
    expect(harness.logsRequests).toHaveLength(1);
  });

  test('live mode polls, pauses while hidden and stops without duplicate intervals', async () => {
    const harness = await bootLogs('live');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');
    expect(harness.logsRequests).toHaveLength(1);

    fakeTimers.useFakeTimers();
    const toggle = liveToggle(dom);
    toggle.checked = true;
    change(dom, toggle);

    // Two ticks produce exactly two polling requests (no duplicate intervals).
    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();
    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(3);

    // Hidden tab pauses polling.
    Object.defineProperty(dom.document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    Object.defineProperty(dom.document, 'hidden', { configurable: true, get: () => true });
    dom.document.dispatchEvent(new dom.window.Event('visibilitychange') as never);
    await flushMicrotasks();

    fakeTimers.advanceTimersByTime(15000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(3);

    // Visible again resumes exactly one interval.
    Object.defineProperty(dom.document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(dom.document, 'hidden', { configurable: true, get: () => false });
    dom.document.dispatchEvent(new dom.window.Event('visibilitychange') as never);
    await flushMicrotasks();

    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(4);
  });

  test('leaving /logs stops polling and returning reloads page 1', async () => {
    const harness = await bootLogs('leave');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    fakeTimers.useFakeTimers();
    const toggle = liveToggle(dom);
    toggle.checked = true;
    change(dom, toggle);
    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(2);

    dom.window.history.pushState({}, '', '/');
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate') as never);
    await flushMicrotasks();

    const before = harness.logsRequests.length;
    fakeTimers.advanceTimersByTime(20000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(before);

    dom.window.history.pushState({}, '', '/logs');
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate') as never);
    await flushMicrotasks();

    expect(harness.logsRequests.length).toBe(before + 1);
    expect(harness.logsRequests[harness.logsRequests.length - 1]!.searchParams.get('offset')).toBe(
      '0'
    );
  });

  test('caps the rendered DOM at 500 rows and shows the notice', async () => {
    const harness = await bootLogs('cap', { total: 600, rowsPerPage: 600 });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 500, 'the capped log table');

    expect(dom.document.querySelectorAll('.logs-row')).toHaveLength(500);
    expect(dom.document.querySelector('.logs-cap-notice')?.textContent).toContain('100 older');
  });

  test('clear logs uses the accessible confirmation, DELETEs and reloads', async () => {
    const harness = await bootLogs('clear');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    click(dom, dom.document.getElementById('btn-clear-logs') as HTMLElement);
    await flushMicrotasks();
    expect(dom.document.getElementById('modal-delete')?.hasAttribute('open')).toBe(true);

    const confirmBtn = dom.document.getElementById('modal-delete-confirm') as HTMLButtonElement;
    click(dom, confirmBtn);

    await waitFor(() => harness.deleteCalls === 1, 'the DELETE request');
    await waitFor(() => harness.logsRequests.length === 2, 'the reload after clearing');
    expect(harness.deleteCalls).toBe(1);
    expect(harness.logsRequests).toHaveLength(2);
    expect(harness.logsRequests[1]!.searchParams.get('offset')).toBe('0');
  });

  test('shows the error state and retry reloads the same page', async () => {
    const harness = await bootLogs('error-retry', { failFirst: true });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => dom.document.querySelector('.logs-error') !== null, 'the logs error state');

    expect(dom.document.querySelector('.logs-error')?.textContent).toContain('Logs failed');

    click(dom, dom.document.getElementById('logs-retry') as HTMLElement);

    await waitFor(() => rows(dom).length === 25, 'the retried first page');
    expect(harness.logsRequests).toHaveLength(2);
    expect(harness.logsRequests[1]!.searchParams.get('offset')).toBe('0');
  });

  test('keeps the focused filter control and status node across a filter change', async () => {
    const harness = await bootLogs('focus-filter');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    const source = dom.document.getElementById('log-filter-source') as HTMLSelectElement;
    const status = dom.document.getElementById('logs-status') as HTMLElement;
    source.focus();
    expect(dom.document.activeElement).toBe(source);

    source.value = 'cli';
    change(dom, source);

    await waitFor(() => harness.logsRequests.length === 2, 'the filtered request');

    // Same node identity: the persistent filter bar and status region are never
    // torn down by a state update.
    expect(dom.document.getElementById('log-filter-source')).toBe(source);
    expect(dom.document.activeElement).toBe(source);
    expect(dom.document.getElementById('logs-status')).toBe(status);
    expect(status.textContent).toContain('Showing');
  });

  test('returns focus to the details button after expanding details', async () => {
    const harness = await bootLogs('focus-details');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    const toggle = dom.document.querySelector('.logs-details-toggle') as HTMLButtonElement;
    toggle.focus();
    expect(dom.document.activeElement).toBe(toggle);

    click(dom, toggle);
    await flushMicrotasks();

    expect(dom.document.querySelector('.logs-details-row')).not.toBeNull();
    const focused = dom.document.activeElement as HTMLElement | null;
    expect(focused?.classList.contains('logs-details-toggle')).toBe(true);
    expect(focused?.getAttribute('aria-expanded')).toBe('true');
    expect(harness.logsRequests).toHaveLength(1);
  });

  test('a live poll updates rows without stealing focus or typed filter text', async () => {
    const harness = await bootLogs('live-focus');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    fakeTimers.useFakeTimers();
    const toggle = liveToggle(dom);
    toggle.checked = true;
    change(dom, toggle);

    const operation = dom.document.getElementById('log-filter-operation') as HTMLInputElement;
    operation.focus();
    operation.value = 'add_mem';
    operation.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as never);

    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();

    expect(harness.logsRequests.length).toBeGreaterThanOrEqual(2);
    expect(dom.document.getElementById('log-filter-operation')).toBe(operation);
    expect(dom.document.activeElement).toBe(operation);
    expect(operation.value).toBe('add_mem');
    expect(rows(dom).length).toBe(25);
  });

  test('disabling live stops the polling interval', async () => {
    const harness = await bootLogs('live-stop');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => rows(dom).length === 25, 'the first page of logs');

    fakeTimers.useFakeTimers();
    const toggle = liveToggle(dom);
    toggle.checked = true;
    change(dom, toggle);
    fakeTimers.advanceTimersByTime(5000);
    await flushMicrotasks();
    expect(harness.logsRequests.length).toBe(2);

    const before = harness.logsRequests.length;
    toggle.checked = false;
    change(dom, toggle);

    fakeTimers.advanceTimersByTime(20000);
    await flushMicrotasks();
    expect(harness.logsRequests).toHaveLength(before);
  });

  test('has no legacy polling console noise or renderer left in app.js', () => {
    expect(appSource).not.toContain("console.log('Starting logs polling");
    expect(appSource).not.toContain("console.error('Failed to poll logs");
    expect(appSource).not.toContain('prependNewLogs');
    expect(appSource).not.toContain('createLogElement');
  });
});
