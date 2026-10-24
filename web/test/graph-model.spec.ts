import { describe, expect, test } from 'bun:test';

import {
  buildGraphViewModel,
  deriveEdges,
  nearestNodeInDirection,
  tierFilterState,
} from '../src/domain/graph-model.js';

interface NodeFixture {
  id: string;
  name?: string;
  tier?: number;
  links_to?: string[];
  linked_by?: string[];
  x?: number;
  y?: number;
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

function ids(values: Array<{ id: string | number }>): string[] {
  return values.map(value => String(value.id)).sort();
}

describe('graph model filters', () => {
  test('no search active keeps every node visible and undimmed', () => {
    const nodes = [
      node({ id: 'a', tier: 1 }),
      node({ id: 'b', tier: 2 }),
      node({ id: 'c', tier: 3 }),
    ];

    const model = buildGraphViewModel({ nodes, searchIds: null });

    expect(model.visibleCount).toBe(3);
    expect(model.matchCount).toBe(0);
    expect(model.outsideMatchCount).toBe(0);
    expect(model.truncated).toBe(false);
    for (const item of model.nodes) {
      expect(item.hidden).toBe(false);
      expect(item.dimmed).toBe(false);
      expect(item.match).toBe(false);
    }
  });

  test('search highlights matches and dims every non-match', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];

    const model = buildGraphViewModel({ nodes, searchIds: ['a', 'c'] });

    const byId = new Map(model.nodes.map(item => [item.id, item]));
    expect(byId.get('a')?.match).toBe(true);
    expect(byId.get('a')?.dimmed).toBe(false);
    expect(byId.get('b')?.match).toBe(false);
    expect(byId.get('b')?.dimmed).toBe(true);
    expect(byId.get('c')?.match).toBe(true);
    expect(model.matchCount).toBe(2);
    expect(model.visibleCount).toBe(3);
  });

  test('only-matches hides non-matches and edges touching hidden nodes', () => {
    const nodes = [
      node({ id: 'a', links_to: ['b', 'c'] }),
      node({ id: 'b', links_to: ['c'] }),
      node({ id: 'c' }),
    ];

    const model = buildGraphViewModel({ nodes, searchIds: ['a', 'c'], onlyMatches: true });

    const byId = new Map(model.nodes.map(item => [item.id, item]));
    expect(byId.get('a')?.hidden).toBe(false);
    expect(byId.get('b')?.hidden).toBe(true);
    expect(byId.get('c')?.hidden).toBe(false);
    expect(model.visibleCount).toBe(2);
    expect(model.matchCount).toBe(2);

    // a->b touches a hidden node; a->c endpoints are both visible.
    const visibleEdges = model.edges.filter(edge => edge.visible);
    expect(visibleEdges.map(edge => `${edge.source}->${edge.target}`)).toEqual(['a->c']);
  });

  test('tier filters combine with search', () => {
    const nodes = [
      node({ id: 'a', tier: 1 }),
      node({ id: 'b', tier: 2 }),
      node({ id: 'c', tier: 3 }),
    ];

    const model = buildGraphViewModel({
      nodes,
      searchIds: ['a', 'c'],
      tierFilters: { 1: true, 2: true, 3: false },
    });

    const byId = new Map(model.nodes.map(item => [item.id, item]));
    expect(byId.get('a')?.hidden).toBe(false);
    expect(byId.get('a')?.match).toBe(true);
    expect(byId.get('b')?.hidden).toBe(false);
    expect(byId.get('b')?.dimmed).toBe(true);
    expect(byId.get('c')?.hidden).toBe(true);
    expect(model.visibleCount).toBe(2);
    expect(model.matchCount).toBe(1);
  });

  test('tier filters hide tiers without an active search', () => {
    const nodes = [node({ id: 'a', tier: 1 }), node({ id: 'b', tier: 3 })];

    const model = buildGraphViewModel({ nodes, tierFilters: { 3: false } });

    const byId = new Map(model.nodes.map(item => [item.id, item]));
    expect(byId.get('a')?.hidden).toBe(false);
    expect(byId.get('b')?.hidden).toBe(true);
    expect(byId.get('a')?.dimmed).toBe(false);
    expect(model.visibleCount).toBe(1);
  });

  test('counts search matches that fall outside the returned node set', () => {
    const nodes = [node({ id: 'a' })];

    const model = buildGraphViewModel({ nodes, searchIds: ['a', 'ghost-1', 'ghost-2'] });

    expect(model.outsideMatchCount).toBe(2);
    expect(model.truncated).toBe(true);
    expect(model.matchCount).toBe(1);
  });
});

describe('graph model tierFilterState', () => {
  test('defaults to all tiers enabled', () => {
    expect(tierFilterState(undefined)).toEqual({ 1: true, 2: true, 3: true });
    expect(tierFilterState(null)).toEqual({ 1: true, 2: true, 3: true });
  });

  test('reads a boolean record and a set of enabled tiers', () => {
    expect(tierFilterState({ 1: false, 3: false })).toEqual({ 1: false, 2: true, 3: false });
    expect(tierFilterState(['1', '3'])).toEqual({ 1: true, 2: false, 3: true });
    expect(tierFilterState(new Set([2]))).toEqual({ 1: false, 2: true, 3: false });
  });
});

describe('deriveEdges', () => {
  test('dedupes directional edges and drops self-edges', () => {
    const nodes = [
      node({ id: 'a', links_to: ['b', 'b', 'c'], linked_by: [] }),
      node({ id: 'b', links_to: [], linked_by: ['a', 'a'] }),
      node({ id: 'c', links_to: ['c'], linked_by: [] }),
    ];

    const edges = deriveEdges(nodes).map(edge => `${edge.source}->${edge.target}`);

    expect(edges.sort()).toEqual(['a->b', 'a->c']);
  });
});

describe('nearestNodeInDirection', () => {
  const positioned: NodeFixture[] = [
    node({ id: 'center', x: 100, y: 100 }),
    node({ id: 'right', x: 300, y: 140 }),
    node({ id: 'left', x: 0, y: 100 }),
    node({ id: 'down', x: 120, y: 300 }),
    node({ id: 'up', x: 100, y: 0 }),
  ];

  test('moves to the nearest node in each cardinal direction', () => {
    expect(nearestNodeInDirection(positioned, 'center', 'right')).toBe('right');
    expect(nearestNodeInDirection(positioned, 'center', 'left')).toBe('left');
    expect(nearestNodeInDirection(positioned, 'center', 'down')).toBe('down');
    expect(nearestNodeInDirection(positioned, 'center', 'up')).toBe('up');
  });

  test('returns null at a boundary with no candidate in the direction', () => {
    expect(nearestNodeInDirection(positioned, 'right', 'right')).toBeNull();
    expect(nearestNodeInDirection(positioned, 'left', 'left')).toBeNull();
    expect(nearestNodeInDirection(positioned, 'up', 'up')).toBeNull();
    expect(nearestNodeInDirection(positioned, 'down', 'down')).toBeNull();
  });

  test('falls back to deterministic array order when nodes carry no positions', () => {
    const flat = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];

    expect(nearestNodeInDirection(flat, 'a', 'right')).toBe('b');
    expect(nearestNodeInDirection(flat, 'a', 'down')).toBe('b');
    expect(nearestNodeInDirection(flat, 'a', 'left')).toBe('c');
    expect(nearestNodeInDirection(flat, 'c', 'right')).toBe('a');
  });

  test('returns null for empty nodes and an unknown origin id', () => {
    expect(nearestNodeInDirection([], 'x', 'right')).toBeNull();
    expect(nearestNodeInDirection(positioned, 'missing', 'right')).toBe('center');
  });
});

describe('buildGraphViewModel node metadata', () => {
  test('preserves identity, name, tier, links and derives degree', () => {
    const nodes = [
      node({ id: 'a', name: 'alpha', tier: 1, links_to: ['b'], linked_by: ['c'] }),
      node({ id: 'b' }),
      node({ id: 'c' }),
    ];

    const model = buildGraphViewModel({ nodes, searchIds: null });
    const alpha = model.nodes.find(item => item.id === 'a');

    expect(alpha).toBeDefined();
    expect(alpha?.name).toBe('alpha');
    expect(alpha?.tier).toBe(1);
    expect(alpha?.degree).toBe(2);
    expect(ids(model.nodes)).toEqual(['a', 'b', 'c']);
  });
});
