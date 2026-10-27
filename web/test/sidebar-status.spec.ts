import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const shellCss = readFileSync(join(import.meta.dir, '../styles/components/shell.css'), 'utf8');

/** Extract the first declaration block for an exact selector. */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = shellCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

function cssPixels(rule: string, property: string): number {
  const match = rule.match(new RegExp(`${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`));
  return match ? Number(match[1]) : Number.NaN;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function waitFor(predicate: () => boolean, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${message}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Boot the real app module on the home route with deterministic API replies. */
async function bootHome(scenario: string, options: { url?: string } = {}): Promise<DomHarness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', options.url ?? '/');

  const space = {
    id: 'space-1',
    name: 'projects/mind',
    description: 'Mind project space',
    tags: ['type:project'],
    memory_count: 0,
    hidden: false,
  };

  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);

    if (path === '/api/spaces') {
      return jsonResponse([space]);
    }

    if (path === `/api/spaces/${space.name}`) {
      return jsonResponse(space);
    }

    if (path === `/api/spaces/${space.name}/graph`) {
      return jsonResponse({
        nodes: [],
        meta: { truncated: false, returned_nodes: 0, total_nodes: 0, applied_limit: 1000 },
      });
    }

    if (path === '/api/memories/query') {
      return jsonResponse([], { 'X-Total-Count': '0' });
    }

    if (path === '/api/status') {
      // A space-scoped status reports only that space; the global one is the
      // authoritative total the sidebar badge must keep.
      const scoped = requestUrl.searchParams.has('space');
      return jsonResponse({
        total_spaces: scoped ? 1 : 87,
        total_memories: 1234,
        by_tier: [
          { tier: 1, count: 5 },
          { tier: 2, count: 10 },
          { tier: 3, count: 20 },
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

  await import(/* webpackIgnore: true */ `../src/app.js?sidebar=${scenario}`);

  return dom;
}

describe('P1e sidebar tier pills', () => {
  test('keeps three compact pills spaced across one non-wrapping row', () => {
    const tiers = cssRule('.status-tiers');
    expect(tiers).toMatch(/display:\s*flex/);
    expect(tiers).toMatch(/flex-wrap:\s*nowrap/);
    expect(tiers).toMatch(/width:\s*100%/);
    expect(tiers).toMatch(/align-items:\s*center/);
    expect(tiers).toMatch(/justify-content:\s*space-between/);
    expect(tiers).toMatch(/gap:\s*0/);
    expect(tiers).not.toMatch(/justify-content:\s*flex-start/);

    const pill = cssRule('.status-tier-pill');
    expect(pill).toMatch(/display:\s*inline-flex/);
    expect(pill).toMatch(/flex-shrink:\s*0/);
    expect(pill).toMatch(/white-space:\s*nowrap/);
    expect(cssPixels(pill, 'font-size')).toBeLessThanOrEqual(11);
    expect(cssPixels(pill, 'gap')).toBeLessThanOrEqual(6);

    const padding = pill.match(/padding\s*:\s*(\d+(?:\.\d+)?)px(?:\s+(\d+(?:\.\d+)?)px)?/);
    expect(padding).not.toBeNull();
    expect(Number(padding?.[1])).toBeLessThanOrEqual(6);
    expect(Number(padding?.[2] ?? padding?.[1])).toBeLessThanOrEqual(6);
  });

  test('declares the spaces count badge inside the rail title', () => {
    const dom = installDom();
    try {
      const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
      const count = parsed.querySelector('#space-count');

      expect(count).not.toBeNull();
      expect(count?.classList.contains('space-rail-count')).toBe(true);
      expect(count?.closest('.space-rail-title')).not.toBeNull();
      expect(parsed.querySelector('#status-tiers')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders the total space count and one pill per tier from status', async () => {
    const dom = await bootHome('count');
    cleanup = () => dom.cleanup();

    await waitFor(
      () => dom.document.getElementById('space-count')?.textContent === '87',
      'the sidebar space count'
    );

    const count = dom.document.getElementById('space-count');
    expect(count?.textContent).toBe('87');

    const pills = Array.from(dom.document.querySelectorAll('.status-tier-pill'));
    expect(pills).toHaveLength(3);
    expect(pills.map(pill => pill.querySelector('.status-tier-label')?.textContent)).toEqual([
      'T1',
      'T2',
      'T3',
    ]);
  });

  test('keeps the global space count after a space-scoped status loads', async () => {
    const dom = await bootHome('count-scoped', { url: '/spaces/projects%2Fmind' });
    cleanup = () => dom.cleanup();

    await waitFor(
      () => dom.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to render'
    );
    await waitFor(
      () => dom.document.getElementById('status-spaces')?.textContent?.includes('1 space') === true,
      'the space-scoped status'
    );

    // The panel reports the open space, but the rail badge must stay global.
    expect(dom.document.getElementById('space-count')?.textContent).toBe('87');
  });
});

describe('All spaces navigation state', () => {
  test('marks All spaces current on home and clears it inside a space', async () => {
    const home = await bootHome('all-spaces-home');
    await waitFor(
      () =>
        home.document.getElementById('all-spaces-link')?.getAttribute('aria-current') === 'page',
      'All spaces to be current on home'
    );
    const homeLink = home.document.getElementById('all-spaces-link');
    expect(homeLink?.classList.contains('is-active')).toBe(true);
    home.cleanup();

    const space = await bootHome('all-spaces-space', { url: '/spaces/projects%2Fmind' });
    cleanup = () => space.cleanup();

    await waitFor(
      () => space.document.getElementById('space-title')?.textContent === 'projects/mind',
      'the space route to render'
    );

    const spaceLink = space.document.getElementById('all-spaces-link');
    expect(spaceLink?.getAttribute('aria-current')).toBeNull();
    expect(spaceLink?.classList.contains('is-active')).toBe(false);
  });
});
