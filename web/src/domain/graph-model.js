// @ts-check
/**
 * Pure neural-map graph model: filtering, highlight/dim, edge derivation and
 * keyboard navigation math. No DOM, no fetch, no global state — every function
 * is deterministic so the view and its tests can rely on it.
 */

const EPSILON = 1e-9;
const DIRECTIONS = new Set(['left', 'right', 'up', 'down']);

/** @typedef {string | number} GraphId */
/** @typedef {'left' | 'right' | 'up' | 'down'} GraphDirection */
/** @typedef {{ 1: boolean, 2: boolean, 3: boolean }} TierFilterState */
/**
 * @typedef {Object} GraphNodeInput
 * @property {GraphId} id
 * @property {string} [name]
 * @property {number} [tier]
 * @property {GraphId[]} [links_to]
 * @property {GraphId[]} [linked_by]
 * @property {number} [x]
 * @property {number} [y]
 */
/**
 * @typedef {Object} GraphModelNode
 * @property {GraphId} id
 * @property {string} name
 * @property {number} tier
 * @property {number} degree
 * @property {boolean} match
 * @property {boolean} dimmed
 * @property {boolean} hidden
 * @property {boolean} selected
 * @property {GraphId[]} links_to
 * @property {GraphId[]} linked_by
 */
/**
 * @typedef {Object} GraphEdgeInput
 * @property {GraphId} source
 * @property {GraphId} target
 */
/**
 * @typedef {Object} GraphModelEdge
 * @property {GraphId} source
 * @property {GraphId} target
 * @property {boolean} visible
 * @property {boolean} dimmed
 */

/**
 * @param {Iterable<GraphId>} values
 * @returns {Set<string>}
 */
function toIdSet(values) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const value of values) set.add(String(value));
  return set;
}

/**
 * Normalize any supported tier-filter shape to explicit per-tier booleans.
 *
 * Accepts `null`/`undefined` (all enabled), a record of enabled flags
 * (`{ 3: false }`), or an array/set of the enabled tiers.
 *
 * @param {Record<string | number, boolean> | Iterable<GraphId> | null | undefined} tierFilters
 * @returns {TierFilterState}
 */
function tierFilterState(tierFilters) {
  if (tierFilters == null) return { 1: true, 2: true, 3: true };

  if (typeof (/** @type {any} */ (tierFilters)[Symbol.iterator]) === 'function') {
    const enabled = toIdSet(/** @type {Iterable<GraphId>} */ (tierFilters));
    return { 1: enabled.has('1'), 2: enabled.has('2'), 3: enabled.has('3') };
  }

  /** @type {Record<string | number, boolean>} */
  const record = /** @type {any} */ (tierFilters);
  const read = (/** @type {1 | 2 | 3} */ tier) => record[tier] !== false;
  return { 1: read(1), 2: read(2), 3: read(3) };
}

/**
 * Derive directional edges from each node's outgoing links, deduping repeated
 * pairs and dropping self-edges. `linked_by` only contributes an edge when its
 * counterpart is not already declared, which the dedupe absorbs.
 *
 * @param {readonly GraphNodeInput[]} nodes
 * @returns {GraphEdgeInput[]}
 */
function deriveEdges(nodes) {
  /** @type {GraphEdgeInput[]} */
  const edges = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {GraphId} source @param {GraphId} target */
  function add(source, target) {
    if (source == null || target == null) return;
    if (String(source) === String(target)) return;
    const key = `${String(source)}->${String(target)}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target });
  }

  for (const node of nodes ?? []) {
    for (const target of node.links_to ?? []) add(node.id, target);
    for (const source of node.linked_by ?? []) add(source, node.id);
  }

  return edges;
}

/**
 * @param {readonly (GraphEdgeInput | { source?: GraphId, target?: GraphId })[]} links
 * @returns {GraphEdgeInput[]}
 */
function normalizeEdges(links) {
  /** @type {GraphEdgeInput[]} */
  const edges = [];
  for (const link of links ?? []) {
    if (!link || link.source == null || link.target == null) continue;
    edges.push({ source: link.source, target: link.target });
  }
  return edges;
}

/**
 * Build the render-ready graph view model.
 *
 * Visibility rules:
 * - no active search: every node is visible and none is dimmed.
 * - active search: matches are highlighted and non-matches are dimmed;
 *   `onlyMatches` additionally hides non-matches.
 * - tier filters hide their tiers and combine with the search rules.
 *
 * Edges are visible only when both endpoints are visible and known.
 *
 * @param {Object} [input]
 * @param {readonly GraphNodeInput[]} [input.nodes]
 * @param {readonly GraphEdgeInput[] | null} [input.links]
 * @param {Iterable<GraphId> | null} [input.searchIds]
 * @param {Record<string | number, boolean> | Iterable<GraphId> | null} [input.tierFilters]
 * @param {boolean} [input.onlyMatches]
 * @param {GraphId | null} [input.selectedId]
 * @returns {{
 *   nodes: GraphModelNode[],
 *   edges: GraphModelEdge[],
 *   matchCount: number,
 *   visibleCount: number,
 *   outsideMatchCount: number,
 *   truncated: boolean,
 * }}
 */
function buildGraphViewModel(input = {}) {
  const nodes = input.nodes ?? [];
  const searchActive = input.searchIds != null;
  const searchSet = searchActive ? toIdSet(input.searchIds) : null;
  const tiers = tierFilterState(input.tierFilters ?? null);
  const onlyMatches = input.onlyMatches === true;
  const selectedId = input.selectedId ?? null;

  const nodeIdSet = toIdSet(nodes.map(node => node.id));
  const hiddenIds = new Set();
  const dimmedIds = new Set();

  /** @type {GraphModelNode[]} */
  const modelNodes = nodes.map(node => {
    const idStr = String(node.id);
    const tier = node.tier;
    const tierEnabled = tier !== 1 && tier !== 2 && tier !== 3 ? true : tiers[tier];
    const match = searchActive && Boolean(searchSet?.has(idStr));
    const hidden = !tierEnabled || (searchActive && onlyMatches && !match);
    const dimmed = searchActive && !match && !hidden;

    if (hidden) hiddenIds.add(idStr);
    if (dimmed) dimmedIds.add(idStr);

    const linksTo = Array.from(node.links_to ?? []);
    const linkedBy = Array.from(node.linked_by ?? []);

    return {
      id: node.id,
      name: typeof node.name === 'string' ? node.name : String(node.id),
      tier: typeof tier === 'number' ? tier : 0,
      degree: linksTo.length + linkedBy.length,
      match,
      dimmed,
      hidden,
      selected: selectedId != null && String(selectedId) === idStr,
      links_to: linksTo,
      linked_by: linkedBy,
    };
  });

  const baseEdges = input.links != null ? normalizeEdges(input.links) : deriveEdges(nodes);
  const edges = baseEdges.map(edge => {
    const sourceId = String(edge.source);
    const targetId = String(edge.target);
    const known = nodeIdSet.has(sourceId) && nodeIdSet.has(targetId);
    const visible = known && !hiddenIds.has(sourceId) && !hiddenIds.has(targetId);
    const dimmed = visible && (dimmedIds.has(sourceId) || dimmedIds.has(targetId));
    return { source: edge.source, target: edge.target, visible, dimmed };
  });

  let matchCount = 0;
  let visibleCount = 0;
  for (const modelNode of modelNodes) {
    if (!modelNode.hidden) visibleCount += 1;
    if (modelNode.match && !modelNode.hidden) matchCount += 1;
  }

  let outsideMatchCount = 0;
  if (searchSet) {
    for (const idStr of searchSet) {
      if (!nodeIdSet.has(idStr)) outsideMatchCount += 1;
    }
  }

  return {
    nodes: modelNodes,
    edges,
    matchCount,
    visibleCount,
    outsideMatchCount,
    truncated: outsideMatchCount > 0,
  };
}

/** @param {GraphNodeInput | undefined} node */
function hasPosition(node) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.y);
}

/**
 * @param {GraphDirection} direction
 * @param {number} dx
 * @param {number} dy
 */
function isInDirection(direction, dx, dy) {
  switch (direction) {
    case 'right':
      return dx > EPSILON && Math.abs(dx) >= Math.abs(dy);
    case 'left':
      return dx < -EPSILON && Math.abs(dx) >= Math.abs(dy);
    case 'down':
      return dy > EPSILON && Math.abs(dy) >= Math.abs(dx);
    case 'up':
      return dy < -EPSILON && Math.abs(dy) >= Math.abs(dx);
    default:
      return false;
  }
}

/** @param {GraphId} a @param {GraphId} b */
function compareIds(a, b) {
  return String(a).localeCompare(String(b));
}

/**
 * Find the nearest node in a cardinal direction for roving keyboard focus.
 *
 * Uses node positions when the origin and at least one other node carry finite
 * coordinates. When positions are unavailable it falls back to deterministic
 * array order (next index forward, previous index backward, wrapping).
 *
 * @param {readonly GraphNodeInput[]} nodes
 * @param {GraphId} fromId
 * @param {GraphDirection} direction
 * @returns {GraphId | null}
 */
function nearestNodeInDirection(nodes, fromId, direction) {
  const list = nodes ?? [];
  if (list.length === 0) return null;
  if (!DIRECTIONS.has(direction)) return null;

  const fromIndex = list.findIndex(node => String(node.id) === String(fromId));
  if (fromIndex === -1) return list[0] ? list[0].id : null;

  const from = list[fromIndex];
  const hasOtherPositions = list.some(
    node => String(node.id) !== String(fromId) && hasPosition(node)
  );

  if (hasPosition(from) && hasOtherPositions) {
    /** @type {GraphNodeInput | null} */
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of list) {
      if (String(candidate.id) === String(fromId)) continue;
      if (!hasPosition(candidate)) continue;
      const dx = /** @type {number} */ (candidate.x) - /** @type {number} */ (from.x);
      const dy = /** @type {number} */ (candidate.y) - /** @type {number} */ (from.y);
      if (!isInDirection(direction, dx, dy)) continue;

      const distance = dx * dx + dy * dy;
      if (distance < bestDistance - EPSILON) {
        bestDistance = distance;
        best = candidate;
      } else if (
        Math.abs(distance - bestDistance) <= EPSILON &&
        best &&
        compareIds(candidate.id, best.id) < 0
      ) {
        best = candidate;
      }
    }

    return best ? best.id : null;
  }

  const forward = direction === 'right' || direction === 'down';
  const nextIndex = forward
    ? (fromIndex + 1) % list.length
    : (fromIndex - 1 + list.length) % list.length;
  return list[nextIndex] ? list[nextIndex].id : null;
}

export { buildGraphViewModel, deriveEdges, nearestNodeInDirection, tierFilterState };
