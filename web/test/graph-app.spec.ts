import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { installDom, type DomHarness } from './helpers/dom';

/**
 * App-level wiring for the Neural Map.
 *
 * These boot the real `web/src/app.js` against the real shell markup with a
 * deterministic `fetch` mock. The pure view/model suites cover rendering and
 * filtering math; these tests cover the seam: the graph request, the search
 * store subscription, tier/only-match controls, quiet truncation, node
 * activation, the error/retry path and the pan-vs-click guard.
 */

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const SPACE = 'projects/mind';

interface GraphNodeFixture {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  links_to: string[];
  linked_by: string[];
}

const GRAPH_NODES: GraphNodeFixture[] = [
  { id: 'n1', name: 'alpha', tier: 1, links_to: ['n2'], linked_by: [] },
  { id: 'n2', name: 'beta', tier: 2, links_to: [], linked_by: ['n1'] },
  { id: 'n3', name: 'gamma', tier: 3, links_to: [], linked_by: [] },
  { id: 'n4', name: 'delta', tier: 2, links_to: [], linked_by: [] },
];

/** A memory that matches a search but sits outside a truncated graph. */
const GHOST_NODE: GraphNodeFixture = {
  id: 'ghost',
  name: 'ghost-memory',
  tier: 2,
  links_to: [],
  linked_by: [],
};

interface GraphMeta {
  truncated: boolean;
  returned_nodes: number;
  total_nodes: number;
  applied_limit: number;
  max_limit: number;
}

interface SearchResultFixture {
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: 1 | 2 | 3;
  confidence: 'high' | 'medium' | 'low';
  methods: string[];
  score: number;
  tags: string[];
  changed_at: string;
}

function searchResult(node: GraphNodeFixture): SearchResultFixture {
  return {
    id: node.id,
    space_name: SPACE,
    name: node.name,
    content: `${node.name} content`,
    tier: node.tier,
    confidence: 'high',
    methods: ['fts5'],
    score: 1,
    tags: [],
    changed_at: '2026-10-21T00:00:00.000Z',
  };
}

interface Harness {
  dom: DomHarness;
  graphRequests: URL[];
  searchRequests: URL[];
}

interface HarnessOptions {
  /** Fail the first graph request with a 500. */
  failGraphOnce?: boolean;
  /** Results returned by the mocked `/api/search`. */
  searchResults?: SearchResultFixture[];
  /** Hold a graph response until the returned promise resolves (by request index). */
  graphGate?: (index: number) => Promise<void> | void;
  /** Override the payload for a specific graph request index. */
  graphPayloadFor?: (
    index: number,
    limit: number
  ) => { nodes: GraphNodeFixture[]; meta: GraphMeta };
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
    total_memories: 4,
    by_tier: [
      { tier: 1, count: 1 },
      { tier: 2, count: 2 },
      { tier: 3, count: 1 },
    ],
    rag_enabled: false,
  };
}

function graphPayload(): { nodes: GraphNodeFixture[]; meta: GraphMeta } {
  const nodes = GRAPH_NODES;
  return {
    nodes,
    meta: {
      truncated: false,
      returned_nodes: nodes.length,
      total_nodes: nodes.length,
      applied_limit: 1000,
      max_limit: 1000,
    },
  };
}

function denseGraphNodes(count: number): GraphNodeFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    name: `node-${index}`,
    tier: ((index % 3) + 1) as 1 | 2 | 3,
    links_to:
      index < 60
        ? Array.from({ length: 6 }, (_unused, offset) => `n${(index + offset + 1) % count}`)
        : [],
    linked_by: [],
  }));
}

function memoryDetail(node: GraphNodeFixture) {
  return {
    id: node.id,
    space_name: SPACE,
    name: node.name,
    content: `${node.name} content`,
    tier: node.tier,
    pinned: false,
    tags: [],
    changed_at: '2026-10-21T00:00:00.000Z',
  };
}

/** Build the shell DOM, install a `fetch` mock and boot the real app module. */
async function bootApp(
  url: string,
  scenario: string,
  options: HarnessOptions = {}
): Promise<Harness> {
  const dom = installDom();
  const parsed = new dom.window.DOMParser().parseFromString(indexHtml, 'text/html');
  dom.document.body.innerHTML = parsed.body.innerHTML;
  dom.window.history.replaceState({}, '', url);

  const graphRequests: URL[] = [];
  const searchRequests: URL[] = [];
  const searchResults = options.searchResults ?? [];
  let failGraph = options.failGraphOnce === true;

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestUrl = new URL(raw, 'http://localhost');
    const path = decodeURIComponent(requestUrl.pathname);
    const method = init?.method ?? 'GET';

    if (requestUrl.pathname === '/api/search') {
      searchRequests.push(requestUrl);
      return jsonResponse(searchResults, {
        'X-Total-Count': String(searchResults.length),
        'X-Has-More': 'false',
      });
    }

    if (path === '/api/memories/query') {
      return jsonResponse([], { 'X-Total-Count': '0' });
    }

    if (path === '/api/spaces') {
      return jsonResponse([
        {
          id: 'space-1',
          name: SPACE,
          description: 'Mind project space',
          tags: ['type:project'],
          memory_count: 4,
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
      const index = graphRequests.length;
      graphRequests.push(requestUrl);
      if (failGraph) {
        failGraph = false;
        return new Response(JSON.stringify({ error: 'graph exploded' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const limit = Number(requestUrl.searchParams.get('limit') ?? 1000);
      await options.graphGate?.(index);
      const payload = options.graphPayloadFor
        ? options.graphPayloadFor(index, limit)
        : graphPayload();
      return jsonResponse(payload);
    }

    if (path.startsWith(`/api/spaces/${SPACE}/memories/`)) {
      const name = path.slice(`/api/spaces/${SPACE}/memories/`.length);
      const node = [...GRAPH_NODES, GHOST_NODE].find(item => item.name === name);
      if (node) {
        if (method === 'PATCH') return jsonResponse(memoryDetail(node));
        return jsonResponse(memoryDetail(node));
      }
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === `/api/spaces/${SPACE}/memories`) {
      return jsonResponse([]);
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

  await import(/* webpackIgnore: true */ `../src/app.js?graph=${scenario}`);

  return { dom, graphRequests, searchRequests };
}

/** Poll for a DOM condition with a bounded timeout; never a fixed sleep. */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function click(dom: DomHarness, target: Element): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }) as never
  );
}

function key(dom: DomHarness, target: Element, keyName: string): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: keyName,
      bubbles: true,
      cancelable: true,
    }) as never
  );
}

function pointer(
  dom: DomHarness,
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  input: { pointerId?: number; clientX: number; clientY: number }
): void {
  target.dispatchEvent(
    new dom.window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: input.pointerId ?? 1,
      button: 0,
      clientX: input.clientX,
      clientY: input.clientY,
    }) as never
  );
}

function typeSpaceSearch(document: Document, window: DomHarness['window'], value: string): void {
  const input = document.getElementById('space-search') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
}

function graphNodes(dom: DomHarness): SVGGElement[] {
  return Array.from(dom.document.querySelectorAll<SVGGElement>('#graph-view g.graph-node'));
}

function nodeById(dom: DomHarness, id: string): SVGGElement | null {
  return dom.document.querySelector<SVGGElement>(`#graph-view g.graph-node[data-node-id="${id}"]`);
}

function isPanelOpen(dom: DomHarness): boolean {
  const panel = dom.document.getElementById('memory-panel') as HTMLDialogElement | null;
  return panel !== null && (panel.open === true || panel.hasAttribute('open'));
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('neural map app wiring', () => {
  test('loads the map with limit=1000 and renders accessible nodes and list rows', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'boot-map');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render every node');

    expect(harness.graphRequests).toHaveLength(1);
    expect(harness.graphRequests[0]!.searchParams.get('limit')).toBe('1000');
    expect(dom.document.body.textContent).not.toContain('Load full graph');

    for (const group of graphNodes(dom)) {
      expect(group.getAttribute('role')).toBe('button');
      expect(group.getAttribute('aria-label')).toBeTruthy();
    }

    const rows = Array.from(
      dom.document.querySelectorAll('#graph-view .graph-memory-list tbody tr')
    );
    expect(rows).toHaveLength(4);
    const links = Array.from(
      dom.document.querySelectorAll<HTMLAnchorElement>('#graph-view a.graph-memory-link')
    );
    expect(links.some(link => link.getAttribute('href')?.includes('memory=alpha'))).toBe(true);

    // The map is a labelled group, never an image, and the view keeps one h1.
    expect(dom.document.querySelector('#graph-view [role="img"]')).toBeNull();
    expect(dom.document.querySelectorAll('#space-detail h1')).toHaveLength(1);
    expect(dom.document.querySelectorAll('#graph-view h1')).toHaveLength(0);

    expect(dom.document.getElementById('graph-view')?.classList.contains('hidden')).toBe(false);
    expect(dom.document.getElementById('list-view')?.classList.contains('hidden')).toBe(true);

    // Zoom controls are wired and update the rendered transform.
    click(dom, dom.document.getElementById('btn-graph-zoom-in') as HTMLElement);
    expect(
      dom.document.querySelector('#graph-view g.graph-transform')?.getAttribute('transform')
    ).toContain('scale(1.2)');
  });

  test('search highlights/dims nodes, only-matches hides the rest and the count is live', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'search-highlight', {
      searchResults: [searchResult(GRAPH_NODES[0]!), searchResult(GRAPH_NODES[3]!)],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    typeSpaceSearch(dom.document, dom.window, 'alpha delta');

    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    await waitFor(
      () => nodeById(dom, 'n1')?.classList.contains('is-match') === true,
      'the matching node to be highlighted'
    );

    expect(nodeById(dom, 'n1')?.classList.contains('is-match')).toBe(true);
    expect(nodeById(dom, 'n4')?.classList.contains('is-match')).toBe(true);
    expect(nodeById(dom, 'n2')?.classList.contains('is-dimmed')).toBe(true);
    expect(nodeById(dom, 'n3')?.classList.contains('is-dimmed')).toBe(true);

    const count = dom.document.querySelector('#graph-view .graph-match-count');
    expect(count?.getAttribute('role')).toBe('status');
    expect(count?.getAttribute('aria-live')).toBe('polite');
    expect(count?.textContent).toBe('2 matches');

    const checkbox = dom.document.getElementById('space-filter-only-matches') as HTMLInputElement;
    expect(dom.document.getElementById('space-filter-only-matches-field')?.hidden).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    await waitFor(() => graphNodes(dom).length === 2, 'only matching nodes to remain');
    expect(
      graphNodes(dom)
        .map(group => group.getAttribute('data-node-id'))
        .sort()
    ).toEqual(['n1', 'n4']);
    expect(dom.document.querySelector('#graph-view .graph-match-count')?.textContent).toBe(
      '2 matches'
    );
    // Highlighting is a store-driven re-render, never a refetch.
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('a tier toggle hides that tier and combines with search', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'tier-combine', {
      searchResults: [searchResult(GRAPH_NODES[0]!)],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    const tier3 = dom.document.getElementById('space-tier-3') as HTMLButtonElement;
    expect(tier3.getAttribute('aria-pressed')).toBe('true');
    click(dom, tier3);

    await waitFor(() => graphNodes(dom).length === 3, 'the T3 node to be hidden');
    expect(nodeById(dom, 'n3')).toBeNull();
    expect(dom.document.getElementById('space-tier-3')?.getAttribute('aria-pressed')).toBe('false');

    typeSpaceSearch(dom.document, dom.window, 'alpha');
    await waitFor(
      () => nodeById(dom, 'n1')?.classList.contains('is-match') === true,
      'the search highlight to apply'
    );

    // The tier filter still holds while the search highlight is active.
    expect(nodeById(dom, 'n3')).toBeNull();
    expect(nodeById(dom, 'n2')?.classList.contains('is-dimmed')).toBe(true);
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('a backend-capped payload shows a quiet truncation note, outside matches and no action', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'truncation', {
      searchResults: [searchResult(GHOST_NODE)],
      graphPayloadFor: () => ({
        nodes: GRAPH_NODES.slice(0, 2),
        meta: {
          truncated: true,
          returned_nodes: 2,
          total_nodes: 5,
          applied_limit: 1000,
          max_limit: 1000,
        },
      }),
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 2, 'the capped graph');

    expect(harness.graphRequests).toHaveLength(1);
    expect(harness.graphRequests[0]!.searchParams.get('limit')).toBe('1000');

    const notice = dom.document.querySelector('#graph-view .graph-truncation');
    expect(notice?.textContent).toContain('Showing 2 of 5 nodes.');
    expect(notice?.textContent).not.toContain('Load full graph');
    expect(dom.document.getElementById('graph-load-full')).toBeNull();
    expect(dom.document.body.textContent).not.toContain('Load full graph');

    typeSpaceSearch(dom.document, dom.window, 'ghost');
    await waitFor(
      () => dom.document.querySelector('#graph-view .graph-truncation-matches') !== null,
      'the outside-match notice'
    );
    expect(
      dom.document.querySelector('#graph-view .graph-truncation-matches')?.textContent
    ).toContain('1 match outside the current graph.');

    // There is no separate full-graph request: the single fetch already asked
    // for the backend maximum.
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('keyboard selection and Enter open the node without refetching the graph', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'keyboard-open');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    const first = nodeById(dom, 'n1') as SVGGElement;
    first.focus();

    key(dom, first, 'ArrowRight');
    expect(harness.graphRequests).toHaveLength(1);
    expect(dom.document.activeElement).not.toBe(first);

    const alpha = nodeById(dom, 'n1') as SVGGElement;
    alpha.focus();
    key(dom, alpha, 'Enter');

    await waitFor(
      () => new URL(dom.window.location.href).searchParams.get('memory') === 'alpha',
      'the memory URL to update'
    );
    expect(isPanelOpen(dom)).toBe(true);
    expect(harness.graphRequests).toHaveLength(1);

    // Selection is DOM-only as well.
    expect(alpha.classList.contains('is-selected')).toBe(true);
  });

  test('a Memory List row opens the same memory in place without leaving the map', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'list-activation');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    const node = nodeById(dom, 'n1') as SVGGElement;
    const link = Array.from(
      dom.document.querySelectorAll<HTMLAnchorElement>('#graph-view a.graph-memory-link')
    ).find(anchor => anchor.getAttribute('href')?.includes('memory=alpha')) as HTMLAnchorElement;

    click(dom, link);

    await waitFor(() => isPanelOpen(dom), 'the memory panel');
    await waitFor(
      () => new URL(dom.window.location.href).searchParams.get('memory') === 'alpha',
      'the memory URL to update'
    );

    const url = new URL(dom.window.location.href);
    expect(url.searchParams.get('view')).toBe('map');

    // The map stays on screen with the same SVG, and the list view stays hidden.
    expect(dom.document.getElementById('graph-view')?.classList.contains('hidden')).toBe(false);
    expect(dom.document.getElementById('list-view')?.classList.contains('hidden')).toBe(true);
    expect(nodeById(dom, 'n1')).toBe(node);

    // The row activates the same node state as a direct SVG click.
    expect(node.classList.contains('is-selected')).toBe(true);
    expect(node.getAttribute('aria-current')).toBe('true');
    expect(
      dom.document.querySelectorAll('#graph-view line.graph-edge.is-incident').length
    ).toBeGreaterThan(0);

    // Activation is DOM-only: no graph refetch and no rebuild.
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('clicking a node highlights incident edges, mutes the rest and close clears them', async () => {
    const connected: GraphNodeFixture[] = [
      { id: 'n1', name: 'alpha', tier: 1, links_to: ['n2', 'n3'], linked_by: [] },
      { id: 'n2', name: 'beta', tier: 2, links_to: ['n4'], linked_by: ['n1'] },
      { id: 'n3', name: 'gamma', tier: 3, links_to: [], linked_by: ['n1'] },
      { id: 'n4', name: 'delta', tier: 2, links_to: [], linked_by: ['n2'] },
    ];
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'selection-edges', {
      graphPayloadFor: () => ({
        nodes: connected,
        meta: {
          truncated: false,
          returned_nodes: connected.length,
          total_nodes: connected.length,
          applied_limit: 1000,
          max_limit: 1000,
        },
      }),
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the connected map');

    const alpha = nodeById(dom, 'n1') as SVGGElement;
    click(dom, alpha);
    await waitFor(() => isPanelOpen(dom), 'the memory panel');

    const edges = Array.from(
      dom.document.querySelectorAll<SVGLineElement>('#graph-view line.graph-edge')
    );
    const incident = edges.filter(edge => {
      const source = edge.getAttribute('data-source');
      const target = edge.getAttribute('data-target');
      return source === 'n1' || target === 'n1';
    });
    const muted = edges.filter(edge => edge.classList.contains('is-muted'));

    // n1 -> n2 and n1 -> n3 are outgoing; both stay highlighted. The unrelated
    // n2 -> n4 edge is muted.
    expect(incident.map(edge => edge.getAttribute('data-target')).sort()).toEqual(['n2', 'n3']);
    expect(incident.every(edge => edge.classList.contains('is-incident'))).toBe(true);
    expect(muted.map(edge => edge.getAttribute('data-target'))).toEqual(['n4']);

    const neighbors = Array.from(
      dom.document.querySelectorAll<SVGGElement>('#graph-view g.graph-node.is-neighbor')
    ).map(group => group.getAttribute('data-node-id'));
    expect(neighbors.sort()).toEqual(['n2', 'n3']);

    // Selection is DOM-only: the map element survives and no graph refetch runs.
    expect(nodeById(dom, 'n1')).toBe(alpha);
    expect(harness.graphRequests).toHaveLength(1);

    const dialog = dom.document.getElementById('memory-panel') as HTMLDialogElement;
    click(dom, dialog);
    await waitFor(() => isPanelOpen(dom) === false, 'the panel to close');

    expect(dom.document.querySelectorAll('#graph-view line.graph-edge.is-incident')).toHaveLength(
      0
    );
    expect(dom.document.querySelectorAll('#graph-view line.graph-edge.is-muted')).toHaveLength(0);
    expect(dom.document.querySelectorAll('#graph-view g.graph-node.is-neighbor')).toHaveLength(0);
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('a pan drag over a node does not open the panel; a plain click does', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'pan-vs-click');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    const svg = dom.document.querySelector('#graph-view svg.graph-svg') as SVGSVGElement;
    const group = nodeById(dom, 'n1') as SVGGElement;

    pointer(dom, group, 'pointerdown', { clientX: 100, clientY: 100 });
    pointer(dom, svg, 'pointermove', { clientX: 200, clientY: 180 });
    pointer(dom, svg, 'pointerup', { clientX: 200, clientY: 180 });
    // The click that a browser emits after the drag must be swallowed.
    click(dom, group);

    expect(isPanelOpen(dom)).toBe(false);
    expect(harness.graphRequests).toHaveLength(1);

    click(dom, group);
    await waitFor(() => isPanelOpen(dom) === true, 'the panel after a plain click');
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('a failed graph request shows an alert with retry and recovers', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'error-retry', {
      failGraphOnce: true,
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(
      () => dom.document.querySelector('#graph-view .graph-error') !== null,
      'the graph error state'
    );

    const error = dom.document.querySelector('#graph-view .graph-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('graph exploded');

    click(dom, dom.document.getElementById('graph-retry') as HTMLElement);

    await waitFor(() => graphNodes(dom).length === 4, 'the retried graph');
    expect(harness.graphRequests).toHaveLength(2);
    expect(harness.graphRequests[1]!.searchParams.get('limit')).toBe('1000');
    expect(dom.document.querySelector('#graph-view .graph-error')).toBeNull();
  });

  test('tier and only-matches toggles keep focus and the status live region identity', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'focus-preserve');
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    const status = dom.document.getElementById('graph-status') as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    const tier2 = dom.document.getElementById('space-tier-2') as HTMLButtonElement;
    tier2.focus();
    click(dom, tier2);

    await waitFor(() => nodeById(dom, 'n2') === null, 'the T2 nodes to be hidden');
    expect(dom.document.getElementById('space-tier-2')).toBe(tier2);
    expect(dom.document.activeElement).toBe(tier2);
    expect(tier2.getAttribute('aria-pressed')).toBe('false');
    expect(dom.document.getElementById('graph-status')).toBe(status);

    const checkbox = dom.document.getElementById('space-filter-only-matches') as HTMLInputElement;
    checkbox.focus();
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);

    await waitFor(() => checkbox.checked === true, 'only-matches to apply');
    expect(dom.document.getElementById('space-filter-only-matches')).toBe(checkbox);
    expect(dom.document.activeElement).toBe(checkbox);
    expect(dom.document.getElementById('graph-status')).toBe(status);
    expect(harness.graphRequests).toHaveLength(1);
  });

  test('a stale graph response cannot overwrite a newer one', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'graph-race', {
      graphPayloadFor: index =>
        index === 0
          ? {
              nodes: [GRAPH_NODES[0]!],
              meta: {
                truncated: false,
                returned_nodes: 1,
                total_nodes: 1,
                applied_limit: 1000,
                max_limit: 1000,
              },
            }
          : graphPayload(),
      graphGate: index => (index === 0 ? firstGate : undefined),
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => harness.graphRequests.length === 1, 'the first graph request');

    // A popstate navigation starts a second graph request while the first is
    // still in flight; the newer response arrives first.
    dom.window.dispatchEvent(new dom.window.Event('popstate') as never);
    await waitFor(() => harness.graphRequests.length === 2, 'the second graph request');
    await waitFor(() => graphNodes(dom).length === 4, 'the newer graph to render');

    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 20));

    // The late first response is stale and must be ignored.
    expect(graphNodes(dom)).toHaveLength(4);
    expect(dom.document.querySelector('#graph-view .graph-error')).toBeNull();
  });

  test('typing on the map keeps the map and its match count visible', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map', 'map-search', {
      searchResults: [searchResult(GRAPH_NODES[0]!), searchResult(GRAPH_NODES[3]!)],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');

    typeSpaceSearch(dom.document, dom.window, 'alpha delta');
    await waitFor(() => harness.searchRequests.length === 1, 'the search request');
    await waitFor(
      () => dom.document.querySelector('#graph-status')?.textContent === '2 matches',
      'the match count to update in place'
    );

    // The map stays visible; the Search page never replaces it.
    expect(dom.document.getElementById('space-detail')?.classList.contains('hidden')).toBe(false);
    expect(dom.document.getElementById('graph-view')?.classList.contains('hidden')).toBe(false);
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      true
    );
    expect(dom.document.querySelector('#graph-view .graph-match-count')?.textContent).toBe(
      '2 matches'
    );

    const url = new URL(dom.window.location.href);
    expect(url.pathname).toBe('/spaces/projects%2Fmind');
    expect(url.searchParams.get('view')).toBe('map');
    expect(url.searchParams.get('q')).toBe('alpha delta');
  });

  test.each([465, 567])(
    'renders all %i nodes with degree-scaled circles, bounded culling and a complete table',
    async count => {
      const denseNodes = denseGraphNodes(count);

      const harness = await bootApp(`/spaces/projects%2Fmind?view=map`, `degree-${count}`, {
        graphPayloadFor: () => ({
          nodes: denseNodes,
          meta: {
            truncated: false,
            returned_nodes: denseNodes.length,
            total_nodes: denseNodes.length,
            applied_limit: 1000,
            max_limit: 1000,
          },
        }),
      });
      cleanup = () => harness.dom.cleanup();
      const { dom } = harness;

      await waitFor(() => graphNodes(dom).length === count, `the ${count}-node map to render`);

      expect(harness.graphRequests).toHaveLength(1);
      expect(harness.graphRequests[0]!.searchParams.get('limit')).toBe('1000');
      expect(dom.document.body.textContent).not.toContain('Load full graph');

      const circles = Array.from(
        dom.document.querySelectorAll<SVGCircleElement>('#graph-view circle.graph-node-dot')
      );
      expect(circles).toHaveLength(count);

      const radii = circles.map(circle => Number(circle.getAttribute('r')));
      expect(new Set(radii).size).toBeGreaterThan(1);
      // Dense mode uses a slimmer 7–16 radius envelope to gain air.
      expect(Math.min(...radii)).toBeGreaterThanOrEqual(7);
      expect(Math.min(...radii)).toBeLessThanOrEqual(9);
      expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii));
      expect(Math.max(...radii)).toBeLessThanOrEqual(16);

      const degreeTexts = Array.from(
        dom.document.querySelectorAll<SVGTextElement>('#graph-view text.graph-node-degree')
      );
      expect(degreeTexts).toHaveLength(count);
      for (const text of degreeTexts) {
        expect(text.getAttribute('aria-hidden')).toBe('true');
        expect(text.getAttribute('text-anchor')).toBe('middle');
        const group = text.parentElement!;
        const circle = group.querySelector<SVGCircleElement>('circle.graph-node-dot')!;
        const radius = Number(circle.getAttribute('r'));
        const digits = String(text.textContent).length;
        const fontSize = Number(text.getAttribute('font-size'));
        expect(digits * 0.62 * fontSize).toBeLessThan(radius * 2);
      }

      // Dense maps show no persistent labels until hover/focus/selection.
      const labels = dom.document.querySelectorAll('#graph-view text.graph-label');
      expect(labels.length).toBe(0);

      const edges = dom.document.querySelectorAll('#graph-view line.graph-edge');
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.length).toBeLessThanOrEqual(200);

      // The table mirror still lists every node.
      expect(dom.document.querySelectorAll('#graph-view .graph-memory-list tbody tr')).toHaveLength(
        count
      );
    }
  );

  test('reloading a map route with a query restores the map and highlights matches', async () => {
    const harness = await bootApp('/spaces/projects%2Fmind?view=map&q=alpha', 'map-reload', {
      searchResults: [searchResult(GRAPH_NODES[0]!)],
    });
    cleanup = () => harness.dom.cleanup();
    const { dom } = harness;

    await waitFor(() => graphNodes(dom).length === 4, 'the map to render four nodes');
    await waitFor(() => harness.searchRequests.length === 1, 'the restored search request');
    await waitFor(
      () => nodeById(dom, 'n1')?.classList.contains('is-match') === true,
      'the restored match highlight'
    );

    expect(dom.document.getElementById('graph-view')?.classList.contains('hidden')).toBe(false);
    expect(dom.document.getElementById('space-search-view')?.classList.contains('hidden')).toBe(
      true
    );
    expect(dom.document.querySelector('#graph-view .graph-match-count')?.textContent).toBe(
      '1 match'
    );

    const url = new URL(dom.window.location.href);
    expect(url.searchParams.get('view')).toBe('map');
    expect(url.searchParams.get('q')).toBe('alpha');
  });
});
