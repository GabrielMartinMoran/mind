// @ts-check

import { nodeRadius } from '../../domain/graph-node-metrics.js';

const TWO_PI = Math.PI * 2;

/** Above this rendered-node count the map switches to a culled dense mode. */
const DENSE_NODE_THRESHOLD = 80;
/**
 * Hard bound on the dense-mode context set used for edge rendering. Dense maps
 * never render persistent name labels, but this same bounded focus set still
 * defines which context edges are worth drawing.
 */
const DENSE_LABEL_LIMIT = 16;
/** Hard bound on rendered edges in dense mode. */
const DENSE_EDGE_LIMIT = 200;
/** World-space breathing room between node circles. */
const DEFAULT_LAYOUT_GAP = 12;
/**
 * Minimum centre-to-centre separation between two tier bands. Lanes inside a
 * tier sit closer together (`laneSeparation`); this larger gap keeps T1/T2/T3
 * visually distinct and equally spaced instead of T2→T3 looking like another
 * intra-tier lane.
 */
const TIER_BOUNDARY_GAP = 100;
/** A slimmer radius envelope so dense maps gain air without losing degree encoding. */
const DENSE_RADIUS_OPTIONS = { min: 7, max: 16, scale: 2.5 };
/** Golden-ratio phase keeps adjacent lanes from lining up on the same spokes. */
const GOLDEN_RATIO_FRACTION = 0.6180339887498949;

/** @typedef {{ scale:number, tx:number, ty:number }} GraphTransform */
/** @typedef {{ factor:number, anchorX:number, anchorY:number, minScale:number, maxScale:number }} ZoomOptions */
/** @typedef {string|number} GraphId */
/** @typedef {{ id:GraphId, tier?:number, links_to:GraphId[], linked_by:GraphId[] }} GraphNode */
/** @typedef {{ x:number, y:number }} Point */
/** @typedef {{ centerX?:number, centerY?:number, tierRadius?:Record<1|2|3, number> }} LayoutOptions */

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {GraphTransform} transform @param {ZoomOptions} options */
function zoomTransformAtAnchor(transform, options) {
  const { factor, anchorX, anchorY, minScale, maxScale } = options;
  const currentScale = transform.scale;
  const nextScale = clamp(currentScale * factor, minScale, maxScale);

  if (nextScale === currentScale) {
    return { scale: currentScale, tx: transform.tx, ty: transform.ty };
  }

  const ratio = nextScale / currentScale;
  const nextTx = anchorX - (anchorX - transform.tx) * ratio;
  const nextTy = anchorY - (anchorY - transform.ty) * ratio;

  return { scale: nextScale, tx: nextTx, ty: nextTy };
}

/**
 * Screen-space label sizing. Base zoom stays at ~11.5px so names read without
 * dominating the map, and zooming in caps at 13px instead of ballooning to
 * ~19px. Zoomed-out maps never drop below 11px.
 */
const LABEL_SCREEN_BASE = 11.5;
const LABEL_SCREEN_MIN = 11;
const LABEL_SCREEN_MAX = 13;

/**
 * Desired label size in **screen pixels** for a zoom level. The result is
 * translated to SVG user units by `computeLabelUserFontSize` so the viewBox fit
 * cannot shrink text below the readable floor.
 *
 * @param {number} scale
 * @param {number} [base]
 * @param {number} [min]
 * @param {number} [max]
 */
function computeLabelFontSize(
  scale,
  base = LABEL_SCREEN_BASE,
  min = LABEL_SCREEN_MIN,
  max = LABEL_SCREEN_MAX
) {
  return clamp(base * scale, min, max);
}

/**
 * Convert a desired screen label size into SVG user units. `userScale` is how
 * many screen pixels one user unit currently occupies (viewBox fit × zoom).
 *
 * @param {number} screenFontSize
 * @param {number} userScale
 */
function computeLabelUserFontSize(screenFontSize, userScale) {
  if (!Number.isFinite(userScale) || userScale <= 0) return screenFontSize;
  return screenFontSize / userScale;
}

/** @param {string} name @param {number} [maxVisibleChars] */
function truncateGraphLabel(name, maxVisibleChars = 25) {
  if (maxVisibleChars <= 0) return '…';
  if (name.length <= maxVisibleChars) return name;
  return `${name.slice(0, maxVisibleChars)}…`;
}

/** @param {number} nodeY @param {number} nodeRadius @param {number} [gap] */
function computeLabelY(nodeY, nodeRadius, gap = 4) {
  return nodeY - nodeRadius - gap;
}

function buildGraphLayerOrder() {
  return ['rings', 'edges', 'nodes', 'labels'];
}

/**
 * Circle radius for a combined link degree. Delegates to the shared node
 * metrics so the layout, the SVG view and the unit tests use one curve.
 *
 * @param {number} [degree]
 */
function computeNodeCircleRadius(degree = 0) {
  return nodeRadius(degree);
}

/**
 * Dense maps use a slimmer radius envelope so more nodes fit with real air
 * between their circles while the radius still encodes degree.
 *
 * @param {number} [degree]
 * @param {boolean} [dense]
 */
function computeGraphNodeRadius(degree = 0, dense = false) {
  return nodeRadius(degree, dense ? DENSE_RADIUS_OPTIONS : {});
}

/** @param {number} nodeCount */
function isDenseGraph(nodeCount) {
  return nodeCount > DENSE_NODE_THRESHOLD;
}

/** @param {number} degree */
function computeNodeFillOpacity(degree) {
  return clamp(0.45 + Math.max(0, degree) * 0.08, 0.45, 0.95);
}

/** @param {GraphNode[]} nodes @param {GraphId|null} selectedNodeId */
function buildNeighborhoodFocus(nodes, selectedNodeId) {
  const emptyFocus = {
    active: false,
    centerNodeId: null,
    relatedNodeIds: new Set(),
    incidentEdgeKeys: new Set(),
  };

  if (selectedNodeId == null) return emptyFocus;

  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  if (!selectedNode) return emptyFocus;

  const relatedNodeIds = new Set([selectedNode.id]);
  const incidentEdgeKeys = new Set();

  for (const targetId of selectedNode.links_to ?? []) {
    relatedNodeIds.add(targetId);
    incidentEdgeKeys.add(`${selectedNode.id}->${targetId}`);
  }

  for (const sourceId of selectedNode.linked_by ?? []) {
    relatedNodeIds.add(sourceId);
    incidentEdgeKeys.add(`${sourceId}->${selectedNode.id}`);
  }

  return {
    active: true,
    centerNodeId: selectedNode.id,
    relatedNodeIds,
    incidentEdgeKeys,
  };
}

/**
 * Full deterministic layout result. `positions` stays the compatibility surface
 * used by the view, while `viewBox`, `laneRings` and `laneCounts` let the view
 * scale the world and mirror the concentric lane structure.
 *
 * @param {GraphNode[]} nodes
 * @param {LayoutOptions & { gap?: number, dense?: boolean }} [options]
 */
function createGraphLayout(nodes, options = {}) {
  const gap = Number.isFinite(options.gap)
    ? Math.max(0, /** @type {number} */ (options.gap))
    : DEFAULT_LAYOUT_GAP;
  const dense = options.dense ?? isDenseGraph(nodes.length);
  const centerX = options.centerX ?? 500;
  const centerY = options.centerY ?? 500;
  const tierRadius = options.tierRadius ?? { 1: 130, 2: 230, 3: 330 };
  /** @type {Record<1|2|3, GraphNode[]>} */
  const byTier = { 1: [], 2: [], 3: [] };

  for (const node of nodes) {
    if (node.tier !== 1 && node.tier !== 2 && node.tier !== 3) {
      throw new Error('Invalid tier: ' + node.tier);
    }
    const tierKey = /** @type {1|2|3} */ (node.tier);
    byTier[tierKey].push(node);
  }

  /** @type {Map<GraphId, number>} */
  const radii = new Map();
  let maxRadius = computeGraphNodeRadius(0, dense);
  for (const node of nodes) {
    const degree = (node.links_to?.length ?? 0) + (node.linked_by?.length ?? 0);
    const radius = computeGraphNodeRadius(degree, dense);
    radii.set(node.id, radius);
    if (radius > maxRadius) maxRadius = radius;
  }
  // Adjacent lanes are kept at least this far apart, which alone guarantees
  // that circles on different lanes cannot touch. Tier boundaries use the
  // larger TIER_BOUNDARY_GAP so every tier transition breathes equally.
  const laneSeparation = 2 * maxRadius + gap;
  const tierBoundaryGap = Math.max(laneSeparation, TIER_BOUNDARY_GAP);

  /** @type {Map<GraphId, Point>} */
  const positions = new Map();
  /** @type {Array<{ tier:1|2|3, radius:number }>} */
  const laneRings = [];
  /** @type {Record<1|2|3, number>} */
  const laneCounts = { 1: 0, 2: 0, 3: 0 };
  /** @type {number | null} */
  let previousOuter = null;

  for (const tier of [1, 2, 3]) {
    const tierNodes = byTier[/** @type {1|2|3} */ (tier)];
    if (tierNodes.length === 0) continue;

    const baseRadius = tierRadius[/** @type {1|2|3} */ (tier)];
    const tierInner =
      previousOuter == null ? baseRadius : Math.max(baseRadius, previousOuter + tierBoundaryGap);
    const plan = planTierLanes(
      tierNodes,
      radii,
      tierInner,
      gap,
      laneSeparation,
      previousOuter != null
    );

    for (const lane of plan.lanes) {
      laneRings.push({ tier: /** @type {1|2|3} */ (tier), radius: lane.radius });
      placeLaneNodes(lane, radii, gap, /** @type {1|2|3} */ (tier), centerX, centerY, positions);
    }

    laneCounts[/** @type {1|2|3} */ (tier)] = plan.lanes.length;
    previousOuter = plan.outer;
  }

  let extent = 0;
  for (const node of nodes) {
    const point = positions.get(node.id);
    if (!point) continue;
    const distance = Math.hypot(point.x - centerX, point.y - centerY) + (radii.get(node.id) ?? 0);
    if (distance > extent) extent = distance;
  }
  const padding = 24;
  const viewSize = Math.max(1000, Math.ceil(2 * (extent + padding)));

  return {
    positions,
    center: { x: centerX, y: centerY },
    extent,
    viewSize,
    viewBox: {
      x: centerX - viewSize / 2,
      y: centerY - viewSize / 2,
      size: viewSize,
    },
    laneRings,
    laneCounts,
    dense,
    gap,
    maxRadius,
  };
}

/**
 * Compatibility wrapper: the historical public surface returns only positions.
 *
 * @param {GraphNode[]} nodes
 * @param {LayoutOptions & { gap?: number, dense?: boolean }} [options]
 */
function layoutGraph(nodes, options = {}) {
  return createGraphLayout(nodes, options).positions;
}

/**
 * Pick the lane count that minimises the tier's outer radius, then distribute
 * nodes across those lanes by weight (larger circles count as heavier). Every
 * lane radius is chosen so its slots fit around the circumference, and each
 * successive lane is separated by `laneSeparation`.
 *
 * @param {GraphNode[]} tierNodes
 * @param {Map<GraphId, number>} radii
 * @param {number} tierInner
 * @param {number} gap
 * @param {number} laneSeparation
 * @param {boolean} [fitInner] Prefer a plan whose first lane starts exactly at
 *   `tierInner`. For tiers after T1 this keeps the boundary gap equal instead of
 *   letting one lane's circumference demand push the whole tier outward.
 */
function planTierLanes(tierNodes, radii, tierInner, gap, laneSeparation, fitInner = false) {
  const sorted = [...tierNodes].sort(
    (a, b) => (radii.get(b.id) ?? 0) - (radii.get(a.id) ?? 0) || compareGraphIds(a.id, b.id)
  );
  const maxLanes = Math.min(sorted.length, 12);

  /** @type {null | { lanes: Array<{ index:number, radius:number, nodes:GraphNode[] }>, outer:number }} */
  let best = null;
  /** @type {null | { lanes: Array<{ index:number, radius:number, nodes:GraphNode[] }>, outer:number }} */
  let bestFitted = null;

  for (let laneCount = 1; laneCount <= maxLanes; laneCount++) {
    const groups = partitionLanes(sorted, radii, gap, laneCount);
    /** @type {Array<{ index:number, radius:number, nodes:GraphNode[] }>} */
    const lanes = [];
    let previous = 0;
    let outer = 0;

    for (let index = 0; index < groups.length; index++) {
      const laneNodes = groups[index];
      if (!laneNodes) continue;
      const slotTotal = laneNodes.reduce(
        (sum, node) => sum + 2 * (radii.get(node.id) ?? 0) + gap,
        0
      );
      const requiredRadius = slotTotal / TWO_PI;
      const separated = index === 0 ? tierInner : previous + laneSeparation;
      const radius = Math.max(tierInner, separated, requiredRadius);
      lanes.push({ index, radius, nodes: laneNodes });
      previous = radius;
      outer = radius;
    }

    if (!best || outer < best.outer - 1e-9) {
      best = { lanes, outer };
    }
    const firstLane = lanes[0];
    if (
      fitInner &&
      firstLane &&
      firstLane.radius <= tierInner + 1e-9 &&
      (!bestFitted || outer < bestFitted.outer - 1e-9)
    ) {
      bestFitted = { lanes, outer };
    }
  }

  // `sorted.length` is always at least one, so a plan exists. A fitted plan can
  // use one more lane than the absolute minimum, but it keeps the tier boundary
  // gap exactly `laneSeparation`/`TIER_BOUNDARY_GAP` instead of drifting.
  return /** @type {{ lanes: Array<{ index:number, radius:number, nodes:GraphNode[] }>, outer:number }} */ (
    bestFitted ?? best
  );
}

/**
 * Longest-processing-time style deterministic partition. Nodes are already
 * sorted by descending radius, so assigning each to the lightest lane balances
 * circumference demand without randomness.
 *
 * @param {GraphNode[]} sortedNodes
 * @param {Map<GraphId, number>} radii
 * @param {number} gap
 * @param {number} laneCount
 */
function partitionLanes(sortedNodes, radii, gap, laneCount) {
  /** @type {GraphNode[][]} */
  const lanes = Array.from({ length: laneCount }, () => []);
  const loads = new Array(laneCount).fill(0);

  for (const node of sortedNodes) {
    let target = 0;
    for (let index = 1; index < laneCount; index++) {
      if (loads[index] < loads[target] - 1e-9) target = index;
    }
    lanes[target]?.push(node);
    loads[target] += 2 * (radii.get(node.id) ?? 0) + gap;
  }

  return lanes;
}

/**
 * Place one lane's nodes around its ring. Slots are contiguous arcs sized from
 * each node's diameter plus the gap, so neighbours never overlap.
 *
 * @param {{ index:number, radius:number, nodes:GraphNode[] }} lane
 * @param {Map<GraphId, number>} radii
 * @param {number} gap
 * @param {1|2|3} tier
 * @param {number} centerX
 * @param {number} centerY
 * @param {Map<GraphId, Point>} positions
 */
function placeLaneNodes(lane, radii, gap, tier, centerX, centerY, positions) {
  const phase = (lane.index * GOLDEN_RATIO_FRACTION * TWO_PI + (tier - 1) * 0.35) % TWO_PI;
  let cursor = phase;

  for (const node of lane.nodes) {
    const radius = radii.get(node.id) ?? 0;
    const span = (2 * radius + gap) / lane.radius;
    const angle = cursor + span / 2;
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * lane.radius,
      y: centerY + Math.sin(angle) * lane.radius,
    });
    cursor += span;
  }
}

/**
 * Which nodes show a *persistent* name label. Small maps label every node.
 * Dense maps show **no** persistent labels: the single name label is transient
 * and owned by hover, keyboard focus or selection (see the view), so there is
 * never an arbitrary top-degree or match subset on screen.
 *
 * @param {Array<{ id:GraphId, degree?:number, match?:boolean, selected?:boolean }>} nodes
 * @param {{ dense?:boolean, selectedId?:GraphId|null, searchActive?:boolean, maxLabels?:number }} [options]
 * @returns {Set<string>}
 */
function selectGraphLabelIds(nodes, options = {}) {
  const dense = options.dense ?? isDenseGraph(nodes.length);
  /** @type {Set<string>} */
  const ids = new Set();

  if (dense) return ids;
  for (const node of nodes) ids.add(String(node.id));
  return ids;
}

/**
 * Bounded focus set used only to choose which context edges a dense map draws.
 * This preserves the historical edge budget (selected node, search matches or a
 * degree-ranked top set) independently of the label policy. It never drives
 * persistent labels.
 *
 * @param {Array<{ id:GraphId, degree?:number, match?:boolean, selected?:boolean }>} nodes
 * @param {{ selectedId?:GraphId|null, searchActive?:boolean, maxLabels?:number }} [options]
 * @returns {Set<string>}
 */
function selectDenseEdgeFocusIds(nodes, options = {}) {
  /** @type {Set<string>} */
  const ids = new Set();

  // With an active search only matches define the dense edge context.
  if (options.searchActive) {
    for (const node of nodes) if (node.match) ids.add(String(node.id));
    return ids;
  }

  const selectedId = options.selectedId == null ? null : String(options.selectedId);
  for (const node of nodes) {
    if (node.selected || (selectedId != null && String(node.id) === selectedId)) {
      ids.add(String(node.id));
    }
  }

  const maxLabels = Number.isFinite(options.maxLabels)
    ? Math.max(0, /** @type {number} */ (options.maxLabels))
    : DENSE_LABEL_LIMIT;
  const ranked = nodes
    .filter(node => !ids.has(String(node.id)))
    .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || compareGraphIds(a.id, b.id));
  for (const node of ranked) {
    if (ids.size >= maxLabels) break;
    ids.add(String(node.id));
  }

  return ids;
}

/**
 * Keys (`source->target`) of the dense-mode edges that stay in the DOM. Only
 * edges touching a focused node survive, and the total is capped.
 *
 * @param {Array<{ source:GraphId, target:GraphId, visible?:boolean }>} edges
 * @param {Set<string>} focusedIds
 * @param {number} [limit]
 * @returns {Set<string>}
 */
function selectDenseEdgeKeys(edges, focusedIds, limit = DENSE_EDGE_LIMIT) {
  /** @type {Set<string>} */
  const keys = new Set();
  if (focusedIds.size === 0) return keys;

  for (const edge of edges) {
    if (edge.visible === false) continue;
    const source = String(edge.source);
    const target = String(edge.target);
    if (!focusedIds.has(source) && !focusedIds.has(target)) continue;
    keys.add(`${source}->${target}`);
    if (keys.size >= limit) break;
  }

  return keys;
}

/** @param {GraphId} a @param {GraphId} b */
function compareGraphIds(a, b) {
  return String(a).localeCompare(String(b));
}

export {
  DENSE_EDGE_LIMIT,
  DENSE_LABEL_LIMIT,
  DENSE_NODE_THRESHOLD,
  buildGraphLayerOrder,
  buildNeighborhoodFocus,
  computeGraphNodeRadius,
  computeLabelFontSize,
  computeLabelUserFontSize,
  computeLabelY,
  computeNodeCircleRadius,
  computeNodeFillOpacity,
  createGraphLayout,
  isDenseGraph,
  layoutGraph,
  selectDenseEdgeFocusIds,
  selectDenseEdgeKeys,
  selectGraphLabelIds,
  truncateGraphLabel,
  zoomTransformAtAnchor,
};
