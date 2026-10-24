import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { applyGraphSelection, renderGraphView, createGraphView } from '../src/views/graph-view.js';

import { installDom, type DomHarness } from './helpers/dom';

interface NodeFixture {
  id: string;
  name?: string;
  tier?: number;
  links_to?: string[];
  linked_by?: string[];
}

function node(overrides: Partial<NodeFixture> & { id: string }): NodeFixture {
  return {
    name: overrides.id,
    tier: 2,
    links_to: [],
    linked_by: [],
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    space: { name: 'test' },
    nodes: [],
    edges: null,
    meta: {
      truncated: false,
      returned_nodes: 0,
      total_nodes: 0,
      applied_limit: 1000,
      max_limit: 1000,
    },
    searchActive: false,
    searchIds: null,
    tierFilters: { 1: true, 2: true, 3: true },
    onlyMatches: false,
    selectedId: null,
    status: 'success',
    error: null,
    spaceMode: false,
    ...overrides,
  };
}

function render(
  dom: DomHarness,
  viewState: Record<string, unknown>,
  handlers: Record<string, unknown> = {}
): HTMLElement {
  const view = renderGraphView(viewState as never, handlers as never) as HTMLElement;
  dom.document.body.appendChild(view);
  return view;
}

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

/** The local sprite href of the first icon found inside `root`. */
function iconHref(root: ParentNode | null): string | null {
  return root?.querySelector('svg use')?.getAttribute('href') ?? null;
}

function click(dom: DomHarness, target: Element): void {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  target.dispatchEvent(event as never);
}

function key(dom: DomHarness, target: Element, keyName: string): void {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event as never);
}

function pointer(
  dom: DomHarness,
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  input: { pointerId?: number; button?: number; clientX: number; clientY: number }
): void {
  const event = new dom.window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: input.pointerId ?? 1,
    button: input.button ?? 0,
    clientX: input.clientX,
    clientY: input.clientY,
  });
  target.dispatchEvent(event as never);
}

function pointerHover(
  dom: DomHarness,
  target: Element,
  type: 'pointerenter' | 'pointerleave'
): void {
  const event = new dom.window.PointerEvent(type, {
    bubbles: false,
    cancelable: false,
    pointerId: 1,
  });
  target.dispatchEvent(event as never);
}

describe('graph view semantics', () => {
  test('exposes the map as a group with a label, never as an image', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: [node({ id: 'a' })] }));

      const svg = query<SVGElement>(view, 'svg.graph-svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('role')).toBe('group');
      expect(svg?.getAttribute('role')).not.toBe('img');
      expect(svg?.getAttribute('aria-label')).toContain('test');
    } finally {
      dom.cleanup();
    }
  });

  test('renders nodes as buttons with roving tabindex and a descriptive label', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', name: 'alpha', tier: 1, links_to: ['b'] }),
        node({ id: 'b', name: 'beta', tier: 2, linked_by: ['a'] }),
        node({ id: 'c', name: 'gamma', tier: 3 }),
      ];
      const view = render(dom, baseState({ nodes, selectedId: 'b' }));

      const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
      expect(groups).toHaveLength(3);

      const byId = new Map(groups.map(group => [group.getAttribute('data-node-id'), group]));
      expect(byId.get('b')?.getAttribute('tabindex')).toBe('0');
      expect(byId.get('a')?.getAttribute('tabindex')).toBe('-1');
      expect(byId.get('c')?.getAttribute('tabindex')).toBe('-1');

      for (const group of groups) {
        expect(group.getAttribute('role')).toBe('button');
      }
      const alpha = byId.get('a');
      expect(alpha?.getAttribute('aria-label')).toContain('alpha');
      expect(alpha?.getAttribute('aria-label')).toContain('T1');
      expect(alpha?.getAttribute('aria-label')).toContain('1');
    } finally {
      dom.cleanup();
    }
  });

  test('applies match and dim classes and hides filtered nodes from the map', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c', tier: 3 })];
      const view = render(
        dom,
        baseState({
          nodes,
          searchActive: true,
          searchIds: ['a'],
          tierFilters: { 1: true, 2: true, 3: false },
        })
      );

      const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
      const byId = new Map(groups.map(group => [group.getAttribute('data-node-id'), group]));

      expect(byId.get('a')?.classList.contains('is-match')).toBe(true);
      expect(byId.get('b')?.classList.contains('is-dimmed')).toBe(true);
      expect(byId.has('c')).toBe(false);
      expect(groups).toHaveLength(2);
    } finally {
      dom.cleanup();
    }
  });

  test('renders only visible edges between visible nodes', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', links_to: ['b', 'c'] }),
        node({ id: 'b', links_to: ['c'] }),
        node({ id: 'c' }),
      ];
      const view = render(
        dom,
        baseState({
          nodes,
          searchActive: true,
          searchIds: ['a', 'c'],
          onlyMatches: true,
        })
      );

      const edges = Array.from(view.querySelectorAll('line.graph-edge'));
      expect(edges).toHaveLength(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view selection highlight', () => {
  const selectionNodes = [
    node({ id: 'a', links_to: ['b', 'c'] }),
    node({ id: 'b', links_to: ['d'], linked_by: ['a'] }),
    node({ id: 'c' }),
    node({ id: 'd', links_to: ['a'], linked_by: ['b'] }),
  ];

  function edgesByKey(view: ParentNode): Map<string, SVGLineElement> {
    return new Map(
      Array.from(view.querySelectorAll<SVGLineElement>('line.graph-edge')).map(line => [
        `${line.getAttribute('data-source')}->${line.getAttribute('data-target')}`,
        line,
      ])
    );
  }

  test('renders every edge with its directed source and target', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: selectionNodes }));
      const edges = edgesByKey(view);

      expect(Array.from(edges.keys()).sort()).toEqual(['a->b', 'a->c', 'b->d', 'd->a']);
      for (const line of edges.values()) {
        expect(line.getAttribute('data-source')).toBeTruthy();
        expect(line.getAttribute('data-target')).toBeTruthy();
      }
    } finally {
      dom.cleanup();
    }
  });

  test('marks incoming and outgoing edges on the initial selected node', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: selectionNodes, selectedId: 'a' }));
      const edges = edgesByKey(view);

      for (const key of ['a->b', 'a->c', 'd->a']) {
        expect(edges.get(key)?.classList.contains('is-incident')).toBe(true);
        expect(edges.get(key)?.classList.contains('is-muted')).toBe(false);
      }
      expect(edges.get('b->d')?.classList.contains('is-incident')).toBe(false);
      expect(edges.get('b->d')?.classList.contains('is-muted')).toBe(true);

      const neighborIds = Array.from(view.querySelectorAll('g.graph-node.is-neighbor')).map(group =>
        group.getAttribute('data-node-id')
      );
      expect(neighborIds.sort()).toEqual(['b', 'c', 'd']);
      expect(
        view.querySelector('g.graph-node[data-node-id="a"]')?.classList.contains('is-neighbor')
      ).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('updates and clears the highlight in place without rebuilding the map', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: selectionNodes }));
      const edgeNodes = Array.from(view.querySelectorAll('line.graph-edge'));
      const nodeGroup = view.querySelector('g.graph-node[data-node-id="a"]');

      applyGraphSelection(view, 'a');

      expect(view.querySelector('g.graph-node[data-node-id="a"]')).toBe(nodeGroup);
      for (const line of edgeNodes) {
        const source = line.getAttribute('data-source');
        const target = line.getAttribute('data-target');
        const incident = source === 'a' || target === 'a';
        expect(line.classList.contains('is-incident')).toBe(incident);
        expect(line.classList.contains('is-muted')).toBe(!incident);
      }

      applyGraphSelection(view, null);

      for (const line of edgeNodes) {
        expect(line.classList.contains('is-incident')).toBe(false);
        expect(line.classList.contains('is-muted')).toBe(false);
      }
      expect(view.querySelectorAll('g.graph-node.is-neighbor')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view degree encoding', () => {
  test('circle radius follows combined incoming and outgoing links', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'isolated' }),
        node({ id: 'warm', links_to: ['a', 'b'], linked_by: ['c', 'd'] }),
        node({ id: 'hub', links_to: Array.from({ length: 41 }, (_, i) => `n${i}`) }),
      ];
      const view = render(dom, baseState({ nodes }));

      const circles = Array.from(view.querySelectorAll<SVGCircleElement>('circle.graph-node-dot'));
      const radiusById = new Map(
        circles.map(circle => [
          circle.parentElement?.getAttribute('data-node-id'),
          Number(circle.getAttribute('r')),
        ])
      );

      expect(radiusById.get('isolated')).toBeGreaterThanOrEqual(8);
      expect(radiusById.get('isolated')).toBeLessThanOrEqual(9);
      expect(radiusById.get('warm')).toBeGreaterThan(radiusById.get('isolated')!);
      expect(radiusById.get('hub')).toBeGreaterThan(radiusById.get('warm')!);
      expect(radiusById.get('hub')).toBeLessThanOrEqual(22);
    } finally {
      dom.cleanup();
    }
  });

  test('renders the degree number centered inside each circle and hides it from AT', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', name: 'zero', links_to: [] }),
        node({ id: 'b', name: 'four', links_to: ['x', 'y', 'z'], linked_by: ['w'] }),
        node({ id: 'c', name: 'hub', links_to: Array.from({ length: 41 }, (_, i) => `n${i}`) }),
      ];
      const view = render(dom, baseState({ nodes }));

      const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
      expect(groups).toHaveLength(3);

      for (const group of groups) {
        const label = group.querySelector<SVGTextElement>('text.graph-node-degree');
        expect(label).not.toBeNull();
        expect(label?.getAttribute('aria-hidden')).toBe('true');
        expect(label?.getAttribute('text-anchor')).toBe('middle');
        expect(label?.getAttribute('dominant-baseline')).toBe('central');

        const circle = group.querySelector<SVGCircleElement>('circle.graph-node-dot')!;
        expect(label?.getAttribute('x')).toBe(circle.getAttribute('cx'));
        expect(label?.getAttribute('y')).toBe(circle.getAttribute('cy'));

        const degree = Number(label?.textContent);
        const radius = Number(circle.getAttribute('r'));
        const fontSize = Number(label?.getAttribute('font-size'));
        const digits = String(label?.textContent).length;

        expect(fontSize).toBeGreaterThanOrEqual(8);
        expect(fontSize).toBeLessThanOrEqual(13);
        // No overflow: approximate digit width must fit inside the circle.
        expect(digits * 0.62 * fontSize).toBeLessThan(radius * 2);
        // The accessible name carries the count because the visual text is hidden.
        expect(group.getAttribute('aria-label')).toContain(`${degree} links`);
      }
    } finally {
      dom.cleanup();
    }
  });

  test('offsets the name label above the circle by its radius', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', name: 'zero' }),
        node({ id: 'b', name: 'hub', links_to: Array.from({ length: 41 }, (_, i) => `n${i}`) }),
      ];
      const view = render(dom, baseState({ nodes }));

      const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
      const labels = Array.from(view.querySelectorAll<SVGTextElement>('text.graph-label'));
      expect(labels).toHaveLength(groups.length);

      groups.forEach((group, index) => {
        const circle = group.querySelector<SVGCircleElement>('circle.graph-node-dot')!;
        const label = labels[index]!;
        const cy = Number(circle.getAttribute('cy'));
        const radius = Number(circle.getAttribute('r'));
        expect(Number(label.getAttribute('y'))).toBe(cy - radius - 4);
      });
    } finally {
      dom.cleanup();
    }
  });

  test('includes the link count in the node accessible name', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a', name: 'alpha', tier: 1, links_to: ['b'], linked_by: ['c'] })];
      const view = render(dom, baseState({ nodes }));

      const group = view.querySelector<SVGGElement>('g.graph-node')!;
      expect(group.getAttribute('aria-label')).toContain('alpha');
      expect(group.getAttribute('aria-label')).toContain('T1');
      expect(group.getAttribute('aria-label')).toContain('2 links');
    } finally {
      dom.cleanup();
    }
  });

  test('uses singular "1 link" and plural "12 links" in the accessible name', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', name: 'single', links_to: ['b'] }),
        node({ id: 'b', name: 'many', links_to: Array.from({ length: 12 }, (_, i) => `n${i}`) }),
      ];
      const view = render(dom, baseState({ nodes }));

      const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
      const labelById = new Map(
        groups.map(group => [group.getAttribute('data-node-id'), group.getAttribute('aria-label')])
      );

      expect(labelById.get('a')).toBe('single. Tier T2. 1 link.');
      expect(labelById.get('b')).toBe('many. Tier T2. 12 links.');
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view controls', () => {
  test('does not own tier or only-matches controls; the shared bar does', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: [node({ id: 'a' })] }));

      expect(view.querySelector('.graph-controls')).toBeNull();
      expect(view.querySelector('.graph-tier-legend')).toBeNull();
      expect(view.querySelector('.graph-only-matches')).toBeNull();
      expect(view.querySelector('#graph-tier-toggle-1')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('applies shared tier and only-matches inputs to the model', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c', tier: 3 })];
      const filtered = render(
        dom,
        baseState({
          nodes,
          searchActive: true,
          searchIds: ['a'],
          tierFilters: [1, 2],
          onlyMatches: true,
        })
      );
      expect(filtered.querySelectorAll('g.graph-node')).toHaveLength(1);
    } finally {
      dom.cleanup();
    }
  });

  test('announces the match count through a polite live region', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        baseState({
          nodes: [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })],
          searchActive: true,
          searchIds: ['a', 'c'],
        })
      );

      const status = query<HTMLElement>(view, '.graph-match-count');
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.getAttribute('aria-live')).toBe('polite');
      expect(status?.textContent).toContain('2');
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view truncation', () => {
  test('quietly explains a backend-capped payload without a load-full action', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        baseState({
          nodes: [node({ id: 'a' })],
          meta: {
            truncated: true,
            returned_nodes: 900,
            total_nodes: 1200,
            applied_limit: 1000,
            max_limit: 1000,
          },
        })
      );

      const notice = query<HTMLElement>(view, '.graph-truncation');
      expect(notice).not.toBeNull();
      expect(notice?.textContent).toContain('900');
      expect(notice?.textContent).toContain('1200');
      expect(notice?.textContent).not.toContain('Load full graph');
      expect(view.querySelector('#graph-load-full')).toBeNull();
      expect(view.querySelector('.graph-load-full')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('reports matches outside the returned graph without a load-full action', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        baseState({
          nodes: [node({ id: 'a' })],
          searchActive: true,
          searchIds: ['a', 'ghost-1', 'ghost-2'],
          meta: {
            truncated: true,
            returned_nodes: 1,
            total_nodes: 5,
            applied_limit: 1000,
            max_limit: 1000,
          },
        })
      );

      const notice = query<HTMLElement>(view, '.graph-truncation');
      expect(notice?.textContent).toContain('2');
      expect(view.querySelector('#graph-load-full')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view accessible memory list', () => {
  test('lists every rendered node with a link to the memory', () => {
    const dom = installDom();
    try {
      const nodes = [
        node({ id: 'a', name: 'alpha', tier: 1 }),
        node({ id: 'b', name: 'beta', tier: 2 }),
      ];
      const view = render(dom, baseState({ nodes }));

      const rows = Array.from(view.querySelectorAll('.graph-memory-list tbody tr'));
      expect(rows).toHaveLength(2);

      const links = Array.from(view.querySelectorAll<HTMLAnchorElement>('.graph-memory-list a'));
      expect(links).toHaveLength(2);
      expect(links[0]?.getAttribute('href')).toContain('/spaces/test');
      expect(links[0]?.getAttribute('href')).toContain('memory=alpha');
      expect(rows[0]?.textContent).toContain('T1');
    } finally {
      dom.cleanup();
    }
  });

  test('wraps the memory table in an open details disclosure for small graphs', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' })];
      const view = render(dom, baseState({ nodes }));

      const details = query<HTMLDetailsElement>(view, 'details.graph-table-details');
      expect(details).not.toBeNull();
      expect(details?.open).toBe(true);

      const summary = details?.querySelector('summary');
      expect(summary?.textContent).toBe('Memory list (2)');
      expect(summary?.classList.contains('graph-list-heading')).toBe(true);
      expect(details?.querySelector('table.graph-memory-list')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('collapses the memory table for dense graphs', () => {
    const dom = installDom();
    try {
      const nodes = Array.from({ length: 51 }, (_, index) =>
        node({ id: `n${index}`, name: `node-${index}` })
      );
      const view = render(dom, baseState({ nodes }));

      const details = query<HTMLDetailsElement>(view, 'details.graph-table-details');
      expect(details?.open).toBe(false);
      expect(details?.querySelector('summary')?.textContent).toBe('Memory list (51)');
      expect(details?.querySelectorAll('tbody tr')).toHaveLength(51);
    } finally {
      dom.cleanup();
    }
  });

  test('mirrors the filtered set, not the raw node set', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' })];
      const view = render(
        dom,
        baseState({ nodes, searchActive: true, searchIds: ['a'], onlyMatches: true })
      );

      expect(view.querySelectorAll('.graph-memory-list tbody tr')).toHaveLength(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view keyboard navigation', () => {
  test('roves focus with arrows and opens with Enter', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];
      const selected: string[] = [];
      const opened: string[] = [];
      const view = render(dom, baseState({ nodes }), {
        onSelectNode: (item: { id: string }) => selected.push(item.id),
        onOpenNode: (item: { id: string }) => opened.push(item.id),
      });

      const first = query<SVGGElement>(view, 'g.graph-node[data-node-id="b"]')!;
      first.focus();
      expect(dom.document.activeElement).toBe(first);

      key(dom, first, 'ArrowRight');

      const active = dom.document.activeElement as SVGGElement;
      expect(active).not.toBe(first);
      const activeId = active.getAttribute('data-node-id');
      expect(activeId).not.toBeNull();
      expect(active.getAttribute('tabindex')).toBe('0');
      expect(first.getAttribute('tabindex')).toBe('-1');
      expect(selected).toEqual([activeId]);

      key(dom, active, 'Enter');
      expect(opened).toEqual([activeId]);
    } finally {
      dom.cleanup();
    }
  });

  test('Home and End jump to the first and last rendered node', () => {
    const dom = installDom();
    try {
      const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];
      const view = render(dom, baseState({ nodes }));

      const start = query<SVGGElement>(view, 'g.graph-node[data-node-id="b"]')!;
      start.focus();

      key(dom, start, 'Home');
      expect((dom.document.activeElement as SVGGElement).getAttribute('data-node-id')).toBe('a');

      key(dom, dom.document.activeElement!, 'End');
      expect((dom.document.activeElement as SVGGElement).getAttribute('data-node-id')).toBe('c');
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view command icons', () => {
  test('toolbar controls use local decorative sprite icons and keep accessible names', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: [node({ id: 'a' })] }));

      const zoomIn = query<HTMLButtonElement>(view, '#btn-graph-zoom-in')!;
      const zoomOut = query<HTMLButtonElement>(view, '#btn-graph-zoom-out')!;
      const reset = query<HTMLButtonElement>(view, '#btn-graph-reset')!;

      expect(iconHref(zoomIn)).toBe('/assets/icons.svg#icon-zoom-in');
      expect(iconHref(zoomOut)).toBe('/assets/icons.svg#icon-zoom-out');
      expect(iconHref(reset)).toBe('/assets/icons.svg#icon-maximize');

      // Icon-only zoom controls must keep an accessible name; the reset keeps
      // its visible label beside the icon.
      expect(zoomIn.getAttribute('aria-label')).toBe('Zoom in');
      expect(zoomOut.getAttribute('aria-label')).toBe('Zoom out');
      expect(zoomIn.textContent?.trim()).toBe('');
      expect(zoomOut.textContent?.trim()).toBe('');
      expect(reset.textContent).toContain('Reset zoom');

      for (const button of [zoomIn, zoomOut, reset]) {
        const svg = button.querySelector('svg')!;
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('focusable')).toBe('false');
      }

      // The old text glyphs are gone.
      expect(zoomIn.textContent).not.toContain('+');
      expect(zoomOut.textContent).not.toContain('−');
    } finally {
      dom.cleanup();
    }
  });

  test('the retry action uses the shared retry icon with its visible label', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ status: 'error', error: 'Network down' }));
      const retry = query<HTMLButtonElement>(view, '.graph-retry')!;

      expect(iconHref(retry)).toBe('/assets/icons.svg#icon-rotate-ccw');
      expect(retry.textContent).toContain('Try again');
      expect(retry.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view pan and zoom', () => {
  test('zoom controls update the transform and reset restores it', () => {
    const dom = installDom();
    try {
      const transforms: Array<{ scale: number; tx: number; ty: number }> = [];
      const view = render(dom, baseState({ nodes: [node({ id: 'a' })] }), {
        onTransformChange: (next: { scale: number; tx: number; ty: number }) =>
          transforms.push(next),
      });

      const group = query<SVGGElement>(view, 'g.graph-transform')!;
      expect(group.getAttribute('transform')).toBe('translate(0 0) scale(1)');

      click(dom, query<HTMLButtonElement>(view, '#btn-graph-zoom-in')!);
      expect(group.getAttribute('transform')).toContain('scale(1.2)');
      expect(transforms.at(-1)?.scale).toBeCloseTo(1.2);

      click(dom, query<HTMLButtonElement>(view, '#btn-graph-reset')!);
      expect(group.getAttribute('transform')).toBe('translate(0 0) scale(1)');
    } finally {
      dom.cleanup();
    }
  });

  test('a pan drag that starts on a node does not open it, while a plain click does', () => {
    const dom = installDom();
    try {
      const opened: string[] = [];
      const view = render(dom, baseState({ nodes: [node({ id: 'a' }), node({ id: 'b' })] }), {
        onOpenNode: (item: { id: string }) => opened.push(item.id),
      });

      const svg = query<SVGSVGElement>(view, 'svg.graph-svg')!;
      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="a"]')!;

      // Capturing on pointerdown would retarget the click to the SVG, so the
      // node's handler would never run. Capture must wait for an actual drag.
      const captures: number[] = [];
      svg.setPointerCapture = ((pointerId: number) => captures.push(pointerId)) as never;

      pointer(dom, group, 'pointerdown', { clientX: 100, clientY: 100 });
      expect(captures).toEqual([]);

      pointer(dom, svg, 'pointermove', { clientX: 180, clientY: 160 });
      expect(captures).toEqual([1]);
      pointer(dom, svg, 'pointerup', { clientX: 180, clientY: 160 });

      // The native click that follows the drag must be swallowed.
      click(dom, group);
      expect(opened).toEqual([]);

      // A later plain click opens the node normally.
      click(dom, group);
      expect(opened).toEqual(['a']);
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view persistent mount', () => {
  test('patches the status live region in place across updates', () => {
    const dom = installDom();
    try {
      const container = dom.document.createElement('div');
      dom.document.body.appendChild(container);
      const { update } = createGraphView(container);

      update(
        baseState({
          nodes: [node({ id: 'a', tier: 1 }), node({ id: 'b', tier: 2 })],
        }) as never
      );

      const status = dom.document.getElementById('graph-status') as HTMLElement;
      expect(status.textContent).toBe('2 nodes');

      update(
        baseState({
          nodes: [node({ id: 'a', tier: 1 }), node({ id: 'b', tier: 2 })],
          tierFilters: [1, 3],
        }) as never
      );

      // Same live-region node; shared tier filters still drive the model.
      expect(dom.document.getElementById('graph-status')).toBe(status);
      expect(status.textContent).toBe('1 node');
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view async and empty states', () => {
  test('renders a skeleton while loading with no nodes', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: [], status: 'loading' }));
      expect(query(view, '.graph-skeleton')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders an empty state when the space has no nodes', () => {
    const dom = installDom();
    try {
      const view = render(dom, baseState({ nodes: [], status: 'success' }));
      expect(query(view, '.graph-empty')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders an error with a retry action', () => {
    const dom = installDom();
    try {
      let retried = 0;
      const view = render(dom, baseState({ nodes: [], status: 'error', error: 'boom' }), {
        onRetry: () => (retried += 1),
      });

      const block = query<HTMLElement>(view, '.graph-error');
      expect(block?.getAttribute('role')).toBe('alert');
      expect(block?.textContent).toContain('boom');

      click(dom, query<HTMLButtonElement>(view, '.graph-retry')!);
      expect(retried).toBe(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('graph view user content safety', () => {
  test('renders node names as text, never as markup', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        baseState({ nodes: [node({ id: 'a', name: '<img src=x onerror="window.__hacked=1">' })] })
      );

      expect(view.querySelector('img')).toBeNull();
      expect(view.textContent).toContain('<img');
    } finally {
      dom.cleanup();
    }
  });

  test('does not build DOM from HTML strings', () => {
    const source = readFileSync(join(import.meta.dir, '../src/views/graph-view.js'), 'utf8');
    expect(source).not.toMatch(/\.innerHTML\s*=/);
    expect(source).not.toMatch(/insertAdjacentHTML/);
  });
});

function denseNodes(count = 300): NodeFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const linksTo =
      index < 60
        ? Array.from({ length: 6 }, (_unused, offset) => `n${(index + offset + 1) % count}`)
        : [];
    return node({
      id: `n${index}`,
      name: `node-${index}`,
      tier: ((index % 3) + 1) as 1 | 2 | 3,
      links_to: linksTo,
    });
  });
}

/**
 * A dense fixture whose focused hub edges alone exceed the 200-edge cap, plus
 * low-degree nodes appended after the hubs so their links fall outside the base
 * capped set. Selecting `low` must materialise its incoming and outgoing edges.
 */
function denseCappedNodes(): NodeFixture[] {
  const hubCount = 90;
  const hubs = Array.from({ length: hubCount }, (_, index) =>
    node({
      id: `h${index}`,
      name: `hub-${index}`,
      tier: ((index % 3) + 1) as 1 | 2 | 3,
      links_to: Array.from(
        { length: 12 },
        (_unused, offset) => `h${(index * 12 + offset + 1) % hubCount}`
      ),
    })
  );

  return [
    ...hubs,
    node({ id: 'lowSource', name: 'low-source', links_to: ['lowTarget'] }),
    node({ id: 'lowTarget', name: 'low-target', linked_by: ['lowSource'] }),
    node({ id: 'low', name: 'low-degree', links_to: ['lowOut'], linked_by: ['lowSource'] }),
    node({ id: 'lowOut', name: 'low-out', linked_by: ['low'] }),
  ];
}

describe('graph view dense-mode culling', () => {
  test('shows no persistent labels by default, keeps every degree number and culled edges', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes }));

      // Dense maps have no persistent names at all.
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);

      // Every node keeps its in-circle degree number.
      expect(view.querySelectorAll('text.graph-node-degree')).toHaveLength(300);

      // Edges are bounded to the focused context instead of all 360 links.
      const edges = view.querySelectorAll('line.graph-edge');
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.length).toBeLessThanOrEqual(200);
      expect(edges.length).toBeLessThan(360);

      // The accessible table mirror stays complete.
      expect(view.querySelectorAll('.graph-memory-list tbody tr')).toHaveLength(300);
    } finally {
      dom.cleanup();
    }
  });

  test('renders one transient dense label at 11–12px screen with a 3–4px halo', () => {
    const dom = installDom();
    const proto = dom.window.SVGSVGElement.prototype as unknown as {
      getScreenCTM?: () => { a: number; b: number; c: number; d: number; e: number; f: number };
    };
    const previous = proto.getScreenCTM;
    // Simulate the SVG viewBox shrinking 1000 user units into 400 screen px.
    proto.getScreenCTM = () => ({ a: 0.4, b: 0, c: 0, d: 0.4, e: 0, f: 0 });
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes }));
      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="n0"]')!;

      pointerHover(dom, group, 'pointerenter');

      const labels = Array.from(view.querySelectorAll<SVGTextElement>('text.graph-label'));
      expect(labels).toHaveLength(1);
      const label = labels[0]!;
      expect(label.getAttribute('data-label-id')).toBe('n0');
      expect(label.classList.contains('is-transient-label')).toBe(true);

      const fontUserUnits = Number(label.getAttribute('font-size'));
      const screenFont = fontUserUnits * 0.4;
      // Exact screen-space metric: 11.5px at base zoom, independent of the
      // viewBox fit (the stub maps 0.4 screen px per user unit).
      expect(screenFont).toBeCloseTo(11.5, 5);
      expect(fontUserUnits).toBeCloseTo(11.5 / 0.4, 5);

      const screenHalo = Number(label.getAttribute('stroke-width')) * 0.4;
      expect(screenHalo).toBeGreaterThanOrEqual(3);
      expect(screenHalo).toBeLessThanOrEqual(4);

      const circle = group.querySelector<SVGCircleElement>('circle.graph-node-dot')!;
      const cy = Number(circle.getAttribute('cy'));
      const radius = Number(circle.getAttribute('r'));
      // Larger type still sits above the circle, never over the degree text.
      expect(Number(label.getAttribute('y'))).toBeLessThanOrEqual(cy - radius - 3.99);

      // Zooming in caps the label at 13px instead of ballooning to ~19px. The
      // stubbed CTM is static, so fold the zoom factor into the screen scale.
      click(dom, query<HTMLButtonElement>(view, '#btn-graph-zoom-in')!);
      const zoomed = query<SVGTextElement>(view, 'text.graph-label')!;
      const zoomedScreen = Number(zoomed.getAttribute('font-size')) * 0.4 * 1.2;
      expect(zoomedScreen).toBeCloseTo(13, 5);
      expect(zoomedScreen).toBeGreaterThan(screenFont);

      // Leaving hides the transient label again.
      pointerHover(dom, group, 'pointerleave');
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);
    } finally {
      if (previous) proto.getScreenCTM = previous;
      else delete proto.getScreenCTM;
      dom.cleanup();
    }
  });

  test('truncates the transient dense label to 24 visible characters with the full title', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300).map((item, index) => ({
        ...item,
        name: `very-long-memory-name-${index}-that-needs-truncation`,
      }));
      const view = render(dom, baseState({ nodes }));

      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);

      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="n0"]')!;
      pointerHover(dom, group, 'pointerenter');

      const label = query<SVGTextElement>(view, 'text.graph-label')!;
      const visible = label.firstChild?.textContent ?? '';
      expect(visible.length).toBeLessThanOrEqual(25);
      expect(visible.endsWith('…')).toBe(true);
      // The full name stays available through the nested <title> tooltip.
      expect(label.querySelector('title')?.textContent).toContain('very-long-memory-name-0');
    } finally {
      dom.cleanup();
    }
  });

  test('shows one label for the selection only, never for search matches', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(
        dom,
        baseState({
          nodes,
          selectedId: 'n250',
          searchActive: true,
          searchIds: ['n120', 'n130'],
        })
      );

      const labels = Array.from(view.querySelectorAll('text.graph-label'));
      expect(labels).toHaveLength(1);
      expect(labels[0]?.getAttribute('data-label-id')).toBe('n250');
      expect(labels[0]?.textContent).toContain('node-250');

      // Matches keep their highlight but never gain a persistent label.
      expect(query(view, 'g.graph-node[data-node-id="n120"]')?.classList.contains('is-match')).toBe(
        true
      );
      expect(labels.some(label => label.textContent?.includes('node-120'))).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('renders all 465 and 567 nodes with no overlaps and bounded culling', () => {
    for (const count of [465, 567]) {
      const dom = installDom();
      try {
        const nodes = denseNodes(count);
        const view = render(dom, baseState({ nodes }));

        const groups = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node'));
        expect(groups).toHaveLength(count);
        expect(view.querySelectorAll('text.graph-node-degree')).toHaveLength(count);
        expect(view.querySelectorAll('.graph-memory-list tbody tr')).toHaveLength(count);

        const labels = view.querySelectorAll('text.graph-label');
        expect(labels).toHaveLength(0);

        const edges = view.querySelectorAll('line.graph-edge');
        expect(edges.length).toBeGreaterThan(0);
        expect(edges.length).toBeLessThanOrEqual(200);

        const circles = groups.map(group => {
          const circle = group.querySelector<SVGCircleElement>('circle.graph-node-dot')!;
          return {
            x: Number(circle.getAttribute('cx')),
            y: Number(circle.getAttribute('cy')),
            r: Number(circle.getAttribute('r')),
          };
        });

        let overlaps = 0;
        let minGap = Number.POSITIVE_INFINITY;
        for (let i = 0; i < circles.length; i += 1) {
          for (let j = i + 1; j < circles.length; j += 1) {
            const gap =
              Math.hypot(circles[i]!.x - circles[j]!.x, circles[i]!.y - circles[j]!.y) -
              circles[i]!.r -
              circles[j]!.r;
            if (gap < 0) overlaps += 1;
            if (gap < minGap) minGap = gap;
          }
        }

        expect(overlaps).toBe(0);
        expect(minGap).toBeGreaterThan(0);
      } finally {
        dom.cleanup();
      }
    }
  });

  test('selection adds exactly one transient label and deselect removes it', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes }));
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);

      applyGraphSelection(view, 'n250');

      const labels = Array.from(view.querySelectorAll('text.graph-label'));
      expect(labels).toHaveLength(1);
      expect(labels[0]?.classList.contains('is-transient-label')).toBe(true);
      expect(labels[0]?.textContent?.includes('node-250')).toBe(true);

      // Selection persists across another selection, still one label.
      applyGraphSelection(view, 'n251');
      const switched = Array.from(view.querySelectorAll('text.graph-label'));
      expect(switched).toHaveLength(1);
      expect(switched[0]?.getAttribute('data-label-id')).toBe('n251');

      // Deselecting drops the transient label.
      applyGraphSelection(view, null);
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });

  test('hover shows one label and leaving hides it', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes }));

      const first = query<SVGGElement>(view, 'g.graph-node[data-node-id="n0"]')!;
      const second = query<SVGGElement>(view, 'g.graph-node[data-node-id="n1"]')!;

      pointerHover(dom, first, 'pointerenter');
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(1);
      expect(query(view, 'text.graph-label')?.getAttribute('data-label-id')).toBe('n0');

      // Moving between nodes keeps exactly one label.
      pointerHover(dom, second, 'pointerenter');
      pointerHover(dom, first, 'pointerleave');
      const labels = Array.from(view.querySelectorAll('text.graph-label'));
      expect(labels).toHaveLength(1);
      expect(labels[0]?.getAttribute('data-label-id')).toBe('n1');

      pointerHover(dom, second, 'pointerleave');
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });

  test('pointer leave keeps the label while the node stays selected', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes, selectedId: 'n0' }));
      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="n0"]')!;

      expect(view.querySelectorAll('text.graph-label')).toHaveLength(1);
      pointerHover(dom, group, 'pointerenter');
      pointerHover(dom, group, 'pointerleave');

      expect(view.querySelectorAll('text.graph-label')).toHaveLength(1);
      expect(query(view, 'text.graph-label')?.getAttribute('data-label-id')).toBe('n0');
    } finally {
      dom.cleanup();
    }
  });

  test('keyboard focus shows one label and blur hides it', () => {
    const dom = installDom();
    try {
      const nodes = denseNodes(300);
      const view = render(dom, baseState({ nodes }));

      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="n5"]')!;
      group.focus();

      expect(view.querySelectorAll('text.graph-label')).toHaveLength(1);
      expect(query(view, 'text.graph-label')?.getAttribute('data-label-id')).toBe('n5');

      group.blur();
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });

  test('small maps label every node persistently and never duplicate on hover', () => {
    const dom = installDom();
    try {
      const nodes = Array.from({ length: 40 }, (_, index) =>
        node({ id: `s${index}`, name: `small-${index}`, tier: ((index % 3) + 1) as 1 | 2 | 3 })
      );
      const view = render(dom, baseState({ nodes }));

      expect(view.querySelectorAll('text.graph-label')).toHaveLength(40);
      expect(view.querySelectorAll('text.graph-label.is-transient-label')).toHaveLength(0);

      const group = query<SVGGElement>(view, 'g.graph-node[data-node-id="s0"]')!;
      pointerHover(dom, group, 'pointerenter');
      // No duplicate transient label; the persistent one already carries it.
      expect(view.querySelectorAll('text.graph-label')).toHaveLength(40);
      expect(view.querySelectorAll('text.graph-label.is-transient-label')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });

  test('materialises incident edges omitted by the dense cap for a low-degree selected node', () => {
    const dom = installDom();
    try {
      const nodes = denseCappedNodes();
      const view = render(dom, baseState({ nodes }));

      const baseEdges = Array.from(view.querySelectorAll<SVGLineElement>('line.graph-edge'));
      expect(baseEdges).toHaveLength(200);
      const baseKeys = new Set(
        baseEdges.map(
          edge => `${edge.getAttribute('data-source')}->${edge.getAttribute('data-target')}`
        )
      );
      // Both directions of the low-degree node's links fall outside the cap.
      expect(baseKeys.has('lowSource->low')).toBe(false);
      expect(baseKeys.has('low->lowOut')).toBe(false);

      const nodeGroup = view.querySelector('g.graph-node[data-node-id="low"]');
      applyGraphSelection(view, 'low');

      // DOM-only: the map and the node element survive.
      expect(view.querySelector('g.graph-node[data-node-id="low"]')).toBe(nodeGroup);

      const edges = Array.from(view.querySelectorAll<SVGLineElement>('line.graph-edge'));
      expect(edges).toHaveLength(202);
      const keys = edges.map(
        edge => `${edge.getAttribute('data-source')}->${edge.getAttribute('data-target')}`
      );
      expect(new Set(keys).size).toBe(keys.length);

      const incident = edges.filter(edge => edge.classList.contains('is-incident'));
      expect(
        incident
          .map(edge => `${edge.getAttribute('data-source')}->${edge.getAttribute('data-target')}`)
          .sort()
      ).toEqual(['low->lowOut', 'lowSource->low']);
      expect(incident.every(edge => edge.classList.contains('is-dynamic'))).toBe(true);
      expect(incident.every(edge => !edge.classList.contains('is-muted'))).toBe(true);

      // Context edges keep the 200-edge cap and stay muted.
      expect(edges.filter(edge => edge.classList.contains('is-muted'))).toHaveLength(200);

      const neighbors = Array.from(view.querySelectorAll<SVGGElement>('g.graph-node.is-neighbor'))
        .map(group => group.getAttribute('data-node-id'))
        .sort();
      expect(neighbors).toEqual(['lowOut', 'lowSource']);

      applyGraphSelection(view, null);

      expect(view.querySelectorAll('line.graph-edge')).toHaveLength(200);
      expect(view.querySelectorAll('line.graph-edge.is-dynamic')).toHaveLength(0);
      expect(view.querySelectorAll('line.graph-edge.is-incident')).toHaveLength(0);
      expect(view.querySelectorAll('line.graph-edge.is-muted')).toHaveLength(0);
      expect(view.querySelectorAll('g.graph-node.is-neighbor')).toHaveLength(0);
    } finally {
      dom.cleanup();
    }
  });

  test('high-degree dense selection highlights every incident edge in both directions', () => {
    const dom = installDom();
    try {
      const nodes = denseCappedNodes();
      nodes.push(
        node({
          id: 'superHub',
          name: 'super-hub',
          tier: 1,
          links_to: ['lowOut', 'lowTarget', 'lowSource'],
          linked_by: Array.from({ length: 39 }, (_unused, index) => `h${index}`),
        })
      );
      const view = render(dom, baseState({ nodes }));
      expect(view.querySelectorAll('line.graph-edge')).toHaveLength(200);

      applyGraphSelection(view, 'superHub');

      const edges = Array.from(view.querySelectorAll<SVGLineElement>('line.graph-edge'));
      expect(edges).toHaveLength(242);
      const keys = edges.map(
        edge => `${edge.getAttribute('data-source')}->${edge.getAttribute('data-target')}`
      );
      expect(new Set(keys).size).toBe(keys.length);

      const incident = edges.filter(edge => edge.classList.contains('is-incident'));
      expect(incident).toHaveLength(42);
      expect(incident.every(edge => edge.classList.contains('is-dynamic'))).toBe(true);

      const incidentKeys = incident.map(
        edge => `${edge.getAttribute('data-source')}->${edge.getAttribute('data-target')}`
      );
      expect(incidentKeys).toContain('h0->superHub');
      expect(incidentKeys).toContain('superHub->lowOut');
      expect(new Set(incidentKeys).size).toBe(42);

      expect(edges.filter(edge => edge.classList.contains('is-muted'))).toHaveLength(200);
      expect(view.querySelectorAll('g.graph-node.is-neighbor')).toHaveLength(42);
    } finally {
      dom.cleanup();
    }
  });
});
