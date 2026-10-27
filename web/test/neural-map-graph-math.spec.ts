import { describe, expect, test } from 'bun:test';

import {
  buildNeighborhoodFocus,
  buildGraphLayerOrder,
  computeGraphNodeRadius,
  computeNodeCircleRadius,
  computeNodeFillOpacity,
  computeLabelY,
  computeLabelFontSize,
  computeLabelUserFontSize,
  createGraphLayout,
  isDenseGraph,
  layoutGraph,
  selectDenseEdgeFocusIds,
  selectDenseEdgeKeys,
  selectGraphLabelIds,
  truncateGraphLabel,
  zoomTransformAtAnchor,
} from '../src/features/graph/graph-math.js';

function denseFixture(count = 300) {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    name: `node-${index}`,
    tier: ((index % 3) + 1) as 1 | 2 | 3,
    links_to:
      index === 0
        ? Array.from({ length: 41 }, (_unused, target) => `n${target + 1}`)
        : index === 1
          ? ['n2', 'n3', 'n4', 'n5']
          : [],
    linked_by: [],
  }));
}

function degreeOf(node: { links_to?: string[]; linked_by?: string[] }) {
  return (node.links_to?.length ?? 0) + (node.linked_by?.length ?? 0);
}

describe('Neural map graph math', () => {
  test('keeps pointer anchor fixed when wheel-zooming', () => {
    const next = zoomTransformAtAnchor(
      { scale: 1, tx: 0, ty: 0 },
      {
        factor: 1.1,
        anchorX: 250,
        anchorY: 120,
        minScale: 0.45,
        maxScale: 2.8,
      }
    );

    expect(next.scale).toBeCloseTo(1.1, 6);
    expect(next.tx).toBeCloseTo(-25, 6);
    expect(next.ty).toBeCloseTo(-12, 6);
  });

  test('anchors button zoom at center point and respects scale bounds', () => {
    const zoomedIn = zoomTransformAtAnchor(
      { scale: 2.7, tx: 5, ty: -3 },
      {
        factor: 1.2,
        anchorX: 500,
        anchorY: 500,
        minScale: 0.45,
        maxScale: 2.8,
      }
    );

    expect(zoomedIn.scale).toBe(2.8);

    const zoomedOut = zoomTransformAtAnchor(
      { scale: 0.5, tx: 1, ty: 1 },
      {
        factor: 0.5,
        anchorX: 500,
        anchorY: 500,
        minScale: 0.45,
        maxScale: 2.8,
      }
    );

    expect(zoomedOut.scale).toBe(0.45);
  });

  test('computes readable screen-space label size by zoom level', () => {
    // Never below 11px on screen even when zoomed out.
    expect(computeLabelFontSize(0.2)).toBeCloseTo(11, 6);
    // ~11.5px at the default zoom.
    expect(computeLabelFontSize(1)).toBeCloseTo(11.5, 6);
    // Zooming in caps at 13px instead of growing to ~19px at 1.44.
    expect(computeLabelFontSize(1.44)).toBeCloseTo(13, 6);
    expect(computeLabelFontSize(10)).toBeCloseTo(13, 6);
  });

  test('converts a screen label size to SVG user units through the viewport scale', () => {
    expect(computeLabelUserFontSize(13, 0.4)).toBeCloseTo(32.5, 6);
    expect(computeLabelUserFontSize(13, 1)).toBeCloseTo(13, 6);
    // Degenerate viewports fall back to the requested screen size.
    expect(computeLabelUserFontSize(13, 0)).toBe(13);
  });

  test('round-trips the base screen size through a real viewBox fit', () => {
    // A 1197-unit viewBox fitted into a 465px-tall canvas yields ~0.389
    // screen px per user unit. The attribute is in user units but the rendered
    // size must still be the base screen size.
    const fit = 0.388875835421888;
    for (const scale of [0.45, 1, 1.44]) {
      const userFont = computeLabelUserFontSize(computeLabelFontSize(scale), fit * scale);
      const screenFont = userFont * fit * scale;
      expect(screenFont).toBeCloseTo(computeLabelFontSize(scale), 6);
    }
    expect(computeLabelFontSize(1)).toBeGreaterThanOrEqual(11.5);
    expect(computeLabelFontSize(1)).toBeLessThanOrEqual(12.5);
    expect(computeLabelFontSize(1.44)).toBeLessThanOrEqual(13);
  });

  test('truncates visible graph labels to 25 chars and appends ellipsis', () => {
    const longName = 'abcdefghijklmnopqrstuvwxyz012345';
    expect(truncateGraphLabel(longName)).toBe('abcdefghijklmnopqrstuvwxy…');
    expect(truncateGraphLabel('short-name')).toBe('short-name');
  });

  test('places labels slightly closer to node circles', () => {
    expect(computeLabelY(200, 20)).toBe(176);
  });

  test('keeps labels in a dedicated top render layer', () => {
    expect(buildGraphLayerOrder()).toEqual(['rings', 'edges', 'nodes', 'labels']);
  });

  test('scales node circle radius with combined connectivity and caps dense hubs', () => {
    const isolated = computeNodeCircleRadius(0);
    const warm = computeNodeCircleRadius(3);
    const connected = computeNodeCircleRadius(18);

    expect(isolated).toBeGreaterThanOrEqual(8);
    expect(isolated).toBeLessThanOrEqual(9);
    expect(warm).toBeGreaterThan(isolated);
    expect(connected).toBeGreaterThan(warm);
    expect(connected).toBeLessThanOrEqual(21);

    // Dense hubs stop growing so they cannot explode the map.
    expect(computeNodeCircleRadius(41)).toBeLessThanOrEqual(21);
    expect(computeNodeCircleRadius(500)).toBe(computeNodeCircleRadius(41));
  });

  test('keeps node fill intensity encoded by connectivity', () => {
    const low = computeNodeFillOpacity(0);
    const high = computeNodeFillOpacity(8);

    expect(low).toBeCloseTo(0.45, 6);
    expect(high).toBeGreaterThan(low);
    expect(computeNodeFillOpacity(999)).toBeCloseTo(0.95, 6);
  });

  test('FEAT-NM-001 SC-NM-001 assigns finite tier-ring coordinates for UUID-backed nodes', () => {
    const centerX = 400;
    const centerY = 300;
    const tierRadius = { 1: 120, 2: 220, 3: 320 };
    const nodes = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        tier: 1,
        name: 'Hot UUID node',
        links_to: [],
        linked_by: [],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        tier: 2,
        name: 'Warm UUID node',
        links_to: [],
        linked_by: [],
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        tier: 3,
        name: 'Cold UUID node',
        links_to: [],
        linked_by: [],
      },
    ];

    const positions = layoutGraph(nodes, { centerX, centerY, tierRadius });

    for (const node of nodes) {
      const point = positions.get(node.id);
      expect(point).toBeDefined();
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);

      const distanceFromCenter = Math.hypot(point.x - centerX, point.y - centerY);
      expect(distanceFromCenter).toBeGreaterThan(tierRadius[node.tier] - 16);
      expect(distanceFromCenter).toBeLessThan(tierRadius[node.tier] + 16);
      expect(Math.hypot(point.x, point.y)).toBeGreaterThan(50);
    }
  });

  test('FEAT-NM-001 SC-NM-002 keeps UUID-backed dense tier spacing deterministic', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      return {
        id: `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`,
        tier: 2,
        name: `UUID Node ${index + 1}`,
        links_to: [],
        linked_by: [],
      };
    });

    const first = layoutGraph(nodes);
    const second = layoutGraph(nodes);

    for (const node of nodes) {
      const p1 = first.get(node.id);
      const p2 = second.get(node.id);
      expect(p1).toEqual(p2);
      expect(Number.isFinite(p1.x)).toBe(true);
      expect(Number.isFinite(p1.y)).toBe(true);
    }

    const points = nodes.map(node => first.get(node.id)).filter(Boolean);
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const distance = Math.hypot(dx, dy);
        if (distance < minDistance) minDistance = distance;
      }
    }

    expect(minDistance).toBeGreaterThan(6);
  });

  test('builds neighborhood focus from direct incoming/outgoing links', () => {
    const nodes = [
      { id: 1, links_to: [2], linked_by: [3] },
      { id: 2, links_to: [3], linked_by: [1] },
      { id: 3, links_to: [1], linked_by: [2] },
      { id: 4, links_to: [], linked_by: [] },
    ];

    const focus = buildNeighborhoodFocus(nodes, 1);

    expect(focus.active).toBe(true);
    expect(focus.centerNodeId).toBe(1);
    expect(Array.from(focus.relatedNodeIds).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(Array.from(focus.incidentEdgeKeys).sort()).toEqual(['1->2', '3->1']);
  });

  test('FEAT-NM-001 SC-NM-003 preserves deterministic best-effort spacing for numeric fixture layouts', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      tier: 2,
      name: `Node ${index + 1}`,
      links_to: [],
      linked_by: [],
    }));

    const first = layoutGraph(nodes);
    const second = layoutGraph(nodes);

    for (const node of nodes) {
      const p1 = first.get(node.id);
      const p2 = second.get(node.id);
      expect(p1).toEqual(p2);
    }

    const points = nodes.map(node => first.get(node.id)).filter(Boolean);
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const distance = Math.hypot(dx, dy);
        if (distance < minDistance) minDistance = distance;
      }
    }

    expect(minDistance).toBeGreaterThan(6);
  });

  test('P2a dense layout keeps 300 node circles apart with concentric lanes', () => {
    const nodes = denseFixture(300);
    const layout = createGraphLayout(nodes);
    const again = createGraphLayout(nodes);

    expect(isDenseGraph(300)).toBe(true);
    expect(layout.dense).toBe(true);
    expect(layout.laneRings.length).toBeGreaterThan(3);
    expect(layout.laneCounts[1]).toBeGreaterThanOrEqual(1);
    expect(layout.laneCounts[2]).toBeGreaterThanOrEqual(1);
    expect(layout.laneCounts[3]).toBeGreaterThanOrEqual(1);

    // Determinism: no random per render.
    for (const node of nodes) {
      expect(layout.positions.get(node.id)).toEqual(again.positions.get(node.id));
    }

    // No overlaps: every pair keeps a strictly positive gap.
    let minGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < nodes.length; i++) {
      const a = layout.positions.get(nodes[i]!.id)!;
      const ra = computeGraphNodeRadius(degreeOf(nodes[i]!), true);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = layout.positions.get(nodes[j]!.id)!;
        const rb = computeGraphNodeRadius(degreeOf(nodes[j]!), true);
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (ra + rb);
        if (gap < minGap) minGap = gap;
      }
    }
    expect(minGap).toBeGreaterThan(0);

    // Tier order: T1 inner, T2 middle, T3 outer.
    const byTier = { 1: [] as number[], 2: [] as number[], 3: [] as number[] };
    for (const node of nodes) {
      const point = layout.positions.get(node.id)!;
      byTier[node.tier].push(Math.hypot(point.x - layout.center.x, point.y - layout.center.y));
    }
    expect(Math.max(...byTier[1])).toBeLessThan(Math.min(...byTier[2]));
    expect(Math.max(...byTier[2])).toBeLessThan(Math.min(...byTier[3]));
  });

  test('P1e spaces T1→T2 and T2→T3 first rings by the same boundary gap', () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `t1-${index}`,
        tier: 1 as const,
        links_to: [],
        linked_by: [],
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `t2-${index}`,
        tier: 2 as const,
        links_to: [],
        linked_by: [],
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `t3-${index}`,
        tier: 3 as const,
        links_to: [],
        linked_by: [],
      })),
    ];

    const layout = createGraphLayout(nodes);
    const firstRingRadius = (tier: 1 | 2 | 3): number => {
      const ring = layout.laneRings.find(candidate => candidate.tier === tier);
      expect(ring, `tier ${tier} should have at least one ring`).toBeDefined();
      return ring!.radius;
    };

    const gap12 = firstRingRadius(2) - firstRingRadius(1);
    const gap23 = firstRingRadius(3) - firstRingRadius(2);

    expect(gap12).toBeCloseTo(100, 6);
    expect(gap23).toBeCloseTo(gap12, 6);
  });

  test('P1e keeps the 465/567 dense tier boundary gaps at 100 world units', () => {
    for (const count of [465, 567]) {
      const layout = createGraphLayout(denseFixture(count));
      const ringsFor = (tier: 1 | 2 | 3) => layout.laneRings.filter(ring => ring.tier === tier);
      const t1 = ringsFor(1);
      const t2 = ringsFor(2);
      const t3 = ringsFor(3);

      expect(t2[0]!.radius - t1.at(-1)!.radius).toBeCloseTo(100, 6);
      expect(t3[0]!.radius - t2.at(-1)!.radius).toBeCloseTo(100, 6);
      expect(layout.viewSize).toBeGreaterThanOrEqual(1000);
      expect(Number.isFinite(layout.extent)).toBe(true);
    }
  });

  test('P2a dense label policy shows no persistent labels and labels every small node', () => {
    const nodes = denseFixture(300).map((node, index) => ({
      ...node,
      degree: degreeOf(node),
      match: index < 3,
      selected: index === 200,
    }));

    // Dense maps never pick a top-degree or match subset for persistent names.
    const denseIds = selectGraphLabelIds(nodes, {
      dense: true,
      searchActive: true,
      selectedId: 'n200',
    });
    expect(denseIds.size).toBe(0);

    // Small maps still label every node.
    const all = selectGraphLabelIds(nodes, { dense: false });
    expect(all.size).toBe(300);
  });

  test('dense edge focus keeps the bounded context independent of labels', () => {
    const nodes = denseFixture(300).map((node, index) => ({
      ...node,
      degree: degreeOf(node),
      match: index < 3,
      selected: index === 200,
    }));

    const ranked = selectDenseEdgeFocusIds(nodes, { selectedId: 'n200' });
    expect(ranked.size).toBeLessThanOrEqual(16);
    expect(ranked.has('n200')).toBe(true);

    const matched = selectDenseEdgeFocusIds(nodes, { searchActive: true });
    expect(Array.from(matched).sort()).toEqual(['n0', 'n1', 'n2']);
  });

  test('P2a dense edge selection keeps only focused incident edges and caps the count', () => {
    const edges = Array.from({ length: 500 }, (_, index) => ({
      source: `n${index}`,
      target: `n${(index + 1) % 500}`,
      visible: true,
    }));

    const keys = selectDenseEdgeKeys(edges, new Set(['n0', 'n250']), 200);
    expect(keys.size).toBeLessThanOrEqual(200);
    for (const key of keys) {
      const [source, target] = key.split('->');
      expect(source === 'n0' || target === 'n0' || source === 'n250' || target === 'n250').toBe(
        true
      );
    }

    expect(selectDenseEdgeKeys(edges, new Set(), 200).size).toBe(0);
  });
});
