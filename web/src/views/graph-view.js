// @ts-check
/**
 * Accessible neural-map view.
 *
 * `renderGraphView` builds the polite match-count status, the truncation
 * notice, the `role="group"` SVG map with roving-tabindex nodes, and the
 * mirrored accessible memory list. Tier toggles and the "Only matches" control
 * live in the shared space filter bar, not in this view. It is a pure DOM
 * builder: it never fetches, reads globals or mutates app state, and it renders
 * user content exclusively through `textContent`/DOM APIs.
 */

import { buildGraphViewModel, nearestNodeInDirection } from '../domain/graph-model.js';
import { nodeDegreeFontSize, nodeDegreeLabel } from '../domain/graph-node-metrics.js';
import {
  buildGraphLayerOrder,
  computeGraphNodeRadius,
  computeLabelFontSize,
  computeLabelUserFontSize,
  computeLabelY,
  computeNodeFillOpacity,
  createGraphLayout,
  selectDenseEdgeFocusIds,
  selectDenseEdgeKeys,
  selectGraphLabelIds,
  truncateGraphLabel,
  zoomTransformAtAnchor,
} from '../features/graph/graph-math.js';
import {
  beginGraphPointerGesture,
  createGraphInteractionState,
  currentGraphPanTransform,
  endGraphPointerGesture,
  updateGraphPointerGesture,
} from '../features/graph/interactions.js';

import { createIcon } from './icon.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Fallback SVG user-unit size used before the viewport scale is known. */
const LABEL_FONT_SIZE = 11.5;
/** Halo stroke width as a fraction of the label's user-unit font size (~3–4px). */
const LABEL_HALO_RATIO = 0.3;
/** Extra gap above the node circle, proportional to the rendered text size. */
const LABEL_GAP_RATIO = 0.18;
const SKELETON_NODES = 6;
const GRAPH_TABLE_OPEN_THRESHOLD = 50;
/** Dense maps show no persistent labels; the transient label is capped at 24 chars. */
const DENSE_LABEL_MAX_CHARS = 24;
/** Small maps keep the historical 25-character label budget. */
const DEFAULT_LABEL_MAX_CHARS = 25;
const GRAPH_SCALE_MIN = 0.45;
const GRAPH_SCALE_MAX = 4.5;

/**
 * Full visible edge list and world positions per rendered SVG. Dense maps cap
 * the edges drawn at render time, but selecting a node must always show every
 * incident edge. Keeping the complete edge list beside the rendered SVG lets
 * the DOM-only selection patch materialise any omitted incident edge without a
 * rebuild or refetch.
 *
 * @type {WeakMap<SVGSVGElement, {
 *   edges: Array<{ source: string | number, target: string | number, visible: boolean, dimmed: boolean }>,
 *   positions: Map<string, { x: number, y: number }>,
 * }>}
 */
const graphEdgeData = new WeakMap();

/**
 * DOM-only transient-label state per rendered SVG. Dense maps show no
 * persistent names, so hover and keyboard focus (in addition to selection) are
 * what make exactly one name visible at a time.
 *
 * @type {WeakMap<SVGSVGElement, string>}
 */
const graphHoverId = new WeakMap();
/** @type {WeakMap<SVGSVGElement, string>} */
const graphFocusId = new WeakMap();

/** @typedef {1 | 2 | 3} Tier */
/** @typedef {import('../domain/graph-model.js').GraphModelNode} GraphModelNode */
/** @typedef {import('../domain/graph-model.js').GraphNodeInput} GraphNodeInput */
/** @typedef {'left' | 'right' | 'up' | 'down'} GraphDirection */
/** @typedef {{ scale: number, tx: number, ty: number }} GraphTransform */

/**
 * @typedef {Object} GraphViewState
 * @property {string | { name?: string } | null} [space]
 * @property {GraphNodeInput[]} [nodes]
 * @property {Array<{ source: import('../domain/graph-model.js').GraphId, target: import('../domain/graph-model.js').GraphId }> | null} [edges]
 * @property {{ truncated?: boolean, returned_nodes?: number, total_nodes?: number, applied_limit?: number, max_limit?: number } | null} [meta]
 * @property {boolean} [searchActive]
 * @property {Array<string | number> | null} [searchIds]
 * @property {Record<string | number, boolean> | Iterable<string | number> | null} [tierFilters]
 * @property {boolean} [onlyMatches]
 * @property {string | number | null} [selectedId]
 * @property {'idle' | 'loading' | 'success' | 'error'} [status]
 * @property {string | null} [error]
 * @property {boolean} [spaceMode]
 * @property {GraphTransform} [transform]
 */

/**
 * @typedef {Object} GraphNodePayload
 * @property {string | number} id
 * @property {string} name
 * @property {number} tier
 * @property {number} degree
 */

/**
 * @typedef {Object} GraphViewHandlers
 * @property {(tier: number) => void} [onTierToggle]
 * @property {(enabled: boolean) => void} [onOnlyMatchesChange]
 * @property {() => void} [onRetry]
 * @property {(node: GraphNodePayload) => void} [onOpenNode]
 * @property {(node: GraphNodePayload) => void} [onSelectNode]
 * @property {(transform: GraphTransform) => void} [onTransformChange]
 */

const KEY_DIRECTIONS = /** @type {Record<string, GraphDirection>} */ ({
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowDown: 'down',
});

/**
 * @param {string} tagName
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} tagName
 * @param {Record<string, string>} [attributes]
 * @param {string} [className]
 * @returns {SVGElement}
 */
function svgElement(tagName, attributes = {}, className) {
  const node = document.createElementNS(SVG_NS, tagName);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (className) node.classList.add(...className.split(' ').filter(Boolean));
  return node;
}

/**
 * Build one name label `<text>` element. Shared by the initial render and the
 * DOM-only selection path so a newly selected node can gain a label without a
 * map rebuild.
 *
 * @param {string} name
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @param {boolean} dimmed
 * @param {string} [extraClass]
 * @param {number} [maxVisibleChars]
 * @param {number} [fontSize] Label size in SVG user units.
 * @returns {SVGTextElement}
 */
function createNameLabel(
  name,
  x,
  y,
  radius,
  dimmed,
  extraClass,
  maxVisibleChars = DEFAULT_LABEL_MAX_CHARS,
  fontSize = LABEL_FONT_SIZE
) {
  const classes = `graph-label${dimmed ? ' is-dimmed' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  const gap = Math.max(4, fontSize * LABEL_GAP_RATIO);
  const label = /** @type {SVGTextElement} */ (
    svgElement(
      'text',
      {
        x: String(x),
        y: String(computeLabelY(y, radius, gap)),
        'text-anchor': 'middle',
        'font-size': String(fontSize),
        'stroke-width': String(fontSize * LABEL_HALO_RATIO),
        'data-node-y': String(y),
        'data-node-radius': String(radius),
      },
      classes
    )
  );
  label.textContent = truncateGraphLabel(name, maxVisibleChars);
  const title = svgElement('title');
  title.textContent = name;
  label.appendChild(title);
  return label;
}

/**
 * Apply the current font size and halo to one label, keeping it above its node
 * without covering the circle or the in-circle degree number.
 *
 * @param {SVGTextElement} label
 * @param {number} fontSize Label size in SVG user units.
 */
function applyLabelMetrics(label, fontSize) {
  label.setAttribute('font-size', String(fontSize));
  label.setAttribute('stroke-width', String(fontSize * LABEL_HALO_RATIO));
  const nodeY = Number(label.getAttribute('data-node-y'));
  const radius = Number(label.getAttribute('data-node-radius'));
  if (Number.isFinite(nodeY) && Number.isFinite(radius)) {
    const gap = Math.max(4, fontSize * LABEL_GAP_RATIO);
    label.setAttribute('y', String(computeLabelY(nodeY, radius, gap)));
  }
}

/**
 * The node the transient name label should follow: selection wins over keyboard
 * focus, which wins over pointer hover.
 *
 * @param {SVGSVGElement} svg
 * @returns {string | null}
 */
function transientLabelId(svg) {
  const selected = svg.querySelector('g.graph-node.is-selected');
  if (selected) return selected.getAttribute('data-node-id');
  const focused = graphFocusId.get(svg);
  if (focused != null) return focused;
  return graphHoverId.get(svg) ?? null;
}

/**
 * Render at most one transient name label for the selected, focused or hovered
 * node. Dense maps show no persistent labels, so this is the only name label
 * they ever display. Fully DOM-only: no rebuild, no refetch.
 *
 * @param {ParentNode} root
 */
function refreshTransientLabel(root) {
  const svg = selectionSvg(root);
  if (!svg) return;
  const labelsLayer = svg.querySelector('g[data-layer="labels"]');
  if (!labelsLayer) return;

  for (const label of Array.from(svg.querySelectorAll('text.graph-label.is-transient-label'))) {
    label.remove();
  }

  const id = transientLabelId(svg);
  if (id == null) return;

  // Small maps already render every name persistently; never duplicate one.
  const hasPersistent = Array.from(
    labelsLayer.querySelectorAll('text.graph-label[data-label-id]')
  ).some(
    label =>
      label.getAttribute('data-label-id') === id && !label.classList.contains('is-transient-label')
  );
  if (hasPersistent) return;

  const node = Array.from(svg.querySelectorAll('g.graph-node')).find(
    group => group.getAttribute('data-node-id') === id
  );
  if (!node) return;

  const circle = node.querySelector('circle.graph-node-dot');
  const radius = Number(circle?.getAttribute('r'));
  const x = Number(circle?.getAttribute('cx'));
  const y = Number(circle?.getAttribute('cy'));
  if (!Number.isFinite(radius) || !Number.isFinite(x) || !Number.isFinite(y)) return;

  const name = node.getAttribute('data-node-name') ?? '';
  const measuredFont = Number(svg.getAttribute('data-label-font-size'));
  const fontSize =
    Number.isFinite(measuredFont) && measuredFont > 0 ? measuredFont : LABEL_FONT_SIZE;
  const label = createNameLabel(
    name,
    x,
    y,
    radius,
    node.classList.contains('is-dimmed'),
    'is-transient-label',
    DENSE_LABEL_MAX_CHARS,
    fontSize
  );
  label.setAttribute('data-label-id', id);
  labelsLayer.appendChild(label);
}

/**
 * How many screen pixels one SVG user unit currently occupies. The viewBox fit
 * and the pan/zoom transform both matter, so measuring the SVG keeps labels at
 * a stable screen size on any viewport.
 *
 * @param {SVGSVGElement} svg
 * @param {number} transformScale
 * @returns {number}
 */
function labelUserScale(svg, transformScale) {
  let viewScale = 0;
  if (typeof svg.getScreenCTM === 'function') {
    try {
      const ctm = svg.getScreenCTM();
      if (ctm && Number.isFinite(ctm.a) && ctm.a > 0) viewScale = ctm.a;
    } catch {
      // Detached or unsupported SVG: fall through to the rect heuristic.
    }
  }
  if (!viewScale) {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox?.baseVal;
    const viewBoxSize = viewBox && viewBox.width > 0 ? viewBox.width : 0;
    if (rect && rect.width > 0 && rect.height > 0 && viewBoxSize > 0) {
      viewScale = Math.min(rect.width, rect.height) / viewBoxSize;
    }
  }
  if (!viewScale) return transformScale;
  return viewScale * transformScale;
}

/**
 * @param {string} id
 * @param {string} className
 * @param {string} text Visible label; empty for icon-only controls.
 * @param {string} [iconName] Allowlisted shared sprite icon.
 * @returns {HTMLButtonElement}
 */
function createButton(id, className, text, iconName) {
  const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  button.type = 'button';
  if (id) button.id = id;
  button.className = className;
  if (iconName) button.appendChild(createIcon(iconName));
  if (text) button.appendChild(document.createTextNode(text));
  return button;
}

/**
 * @param {GraphViewState['space']} space
 * @returns {string}
 */
function spaceNameOf(space) {
  if (typeof space === 'string' && space) return space;
  if (space && typeof space === 'object' && typeof space.name === 'string') return space.name;
  return '';
}

/**
 * @param {string} space
 * @param {string} name
 * @returns {string}
 */
function memoryHref(space, name) {
  const base = space ? `/spaces/${encodeURIComponent(space)}` : '/';
  return `${base}?memory=${encodeURIComponent(name)}`;
}

/** @param {GraphModelNode} node @returns {GraphNodePayload} */
function nodePayload(node) {
  return { id: node.id, name: node.name, tier: node.tier, degree: node.degree };
}

/** @param {number} count */
function matchCountLabel(count) {
  return `${count} ${count === 1 ? 'match' : 'matches'}`;
}

/** @param {number} count */
function nodeCountLabel(count) {
  return `${count} ${count === 1 ? 'node' : 'nodes'}`;
}

/** @param {number} count */
function linkCountLabel(count) {
  return `${count} ${count === 1 ? 'link' : 'links'}`;
}

/**
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @returns {boolean}
 */
function isTruncated(state, model) {
  return state.meta?.truncated === true || model.outsideMatchCount > 0;
}

/**
 * Build the persistent polite status region. Tier and only-matches controls
 * live in the shared space filter bar, so the map only announces its counts.
 *
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @returns {HTMLElement}
 */
function buildStatus(state, model) {
  const container = element('div', 'graph-status-bar');
  const status = element(
    'p',
    'graph-match-count',
    state.searchActive ? matchCountLabel(model.matchCount) : nodeCountLabel(model.visibleCount)
  );
  status.id = 'graph-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  container.appendChild(status);
  return container;
}

/**
 * Patch the persistent status text from a new state without replacing the node.
 *
 * @param {HTMLElement} container
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 */
function syncStatus(container, state, model) {
  const status = container.querySelector('#graph-status');
  if (!status) return;
  status.textContent = state.searchActive
    ? matchCountLabel(model.matchCount)
    : nodeCountLabel(model.visibleCount);
}

/**
 * Quiet truncation notice. The app always requests every node the backend can
 * serve, so this only appears if the backend itself caps the payload, or if a
 * search match sits outside the returned set. There is no separate "load more"
 * action: one request already asks for the full payload.
 *
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @returns {HTMLElement}
 */
function renderTruncation(state, model) {
  const meta = state.meta ?? {};
  const notice = element('div', 'graph-truncation');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');

  if (
    meta.truncated === true &&
    typeof meta.returned_nodes === 'number' &&
    typeof meta.total_nodes === 'number'
  ) {
    notice.appendChild(
      element(
        'p',
        'graph-truncation-summary',
        `Showing ${meta.returned_nodes} of ${meta.total_nodes} nodes.`
      )
    );
  }

  if (model.outsideMatchCount > 0) {
    notice.appendChild(
      element(
        'p',
        'graph-truncation-matches',
        `${matchCountLabel(model.outsideMatchCount)} outside the current graph.`
      )
    );
  }

  return notice;
}

/**
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @param {GraphModelNode[]} renderedNodes
 * @param {ReturnType<typeof createGraphLayout>} layout
 * @param {(node: GraphModelNode) => void} focusNode
 * @param {GraphViewHandlers} handlers
 * @param {GraphTransform} transform
 * @returns {{ svg: SVGElement, transformGroup: SVGGElement, labels: SVGTextElement[] }}
 */
function renderSvg(state, model, renderedNodes, layout, focusNode, handlers, transform) {
  const positions = layout.positions;
  const spaceName = spaceNameOf(state.space);
  const svg = /** @type {SVGSVGElement} */ (
    svgElement(
      'svg',
      {
        viewBox: `${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.size} ${layout.viewBox.size}`,
        role: 'group',
        'aria-label': `Neural map for ${spaceName || 'space'}. ${nodeCountLabel(renderedNodes.length)}.`,
      },
      'graph-svg'
    )
  );

  const transformGroup = /** @type {SVGGElement} */ (svgElement('g', {}, 'graph-transform'));
  transformGroup.setAttribute(
    'transform',
    `translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`
  );
  svg.appendChild(transformGroup);

  /** @type {Map<string, SVGElement>} */
  const layers = new Map();
  for (const layerName of buildGraphLayerOrder()) {
    const layer = svgElement('g', { 'data-layer': layerName });
    layers.set(layerName, layer);
    transformGroup.appendChild(layer);
  }

  /** @type {SVGTextElement[]} */
  const labels = [];
  const dense = layout.dense;
  svg.setAttribute('data-dense', dense ? 'true' : 'false');
  const center = layout.center;

  for (const lane of layout.laneRings) {
    const ring = svgElement(
      'circle',
      {
        cx: String(center.x),
        cy: String(center.y),
        r: String(lane.radius),
        fill: 'none',
      },
      `tier-ring tier-ring-${lane.tier}`
    );
    layers.get('rings')?.appendChild(ring);
  }

  const labelIds = selectGraphLabelIds(renderedNodes, {
    dense,
    selectedId: state.selectedId ?? null,
    searchActive: state.searchActive === true,
  });

  /** @type {Set<string> | null} */
  let denseEdgeKeys = null;
  if (dense) {
    // Edge context stays bounded independently of labels: dense maps never show
    // persistent names, but still draw the most relevant local edges.
    const focusedIds = selectDenseEdgeFocusIds(renderedNodes, {
      selectedId: state.selectedId ?? null,
      searchActive: state.searchActive === true,
    });
    denseEdgeKeys = selectDenseEdgeKeys(model.edges, focusedIds);
  }

  for (const edge of model.edges) {
    if (!edge.visible) continue;
    if (denseEdgeKeys && !denseEdgeKeys.has(`${String(edge.source)}->${String(edge.target)}`)) {
      continue;
    }
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;

    const classes = `graph-edge${dense ? ' is-dense' : ''}${edge.dimmed ? ' is-dimmed' : ''}`;
    const line = svgElement(
      'line',
      {
        x1: String(source.x),
        y1: String(source.y),
        x2: String(target.x),
        y2: String(target.y),
        'data-source': String(edge.source),
        'data-target': String(edge.target),
      },
      classes
    );
    layers.get('edges')?.appendChild(line);
  }

  for (const node of renderedNodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const radius = computeGraphNodeRadius(node.degree, dense);
    const group = /** @type {SVGGElement} */ (
      svgElement(
        'g',
        {
          role: 'button',
          tabindex: '-1',
          'data-node-id': String(node.id),
          'data-node-name': node.name,
          'aria-label': `${node.name}. Tier T${node.tier}. ${linkCountLabel(node.degree)}.`,
          ...(node.selected ? { 'aria-current': 'true' } : {}),
        },
        `graph-node tier-${node.tier}${node.match ? ' is-match' : ''}${node.dimmed ? ' is-dimmed' : ''}${node.selected ? ' is-selected' : ''}`
      )
    );

    const circle = svgElement(
      'circle',
      {
        cx: String(pos.x),
        cy: String(pos.y),
        r: String(radius),
        'fill-opacity': String(computeNodeFillOpacity(node.degree)),
      },
      'graph-node-dot'
    );
    const circleTitle = svgElement('title');
    circleTitle.textContent = node.name;
    circle.appendChild(circleTitle);
    group.appendChild(circle);

    const degreeLabel = nodeDegreeLabel(node.degree);
    const degreeText = svgElement(
      'text',
      {
        x: String(pos.x),
        y: String(pos.y),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': String(nodeDegreeFontSize(radius, degreeLabel.length)),
        'aria-hidden': 'true',
      },
      'graph-node-degree'
    );
    degreeText.textContent = degreeLabel;
    group.appendChild(degreeText);

    group.addEventListener('click', () => handlers.onOpenNode?.(nodePayload(node)));

    // Dense maps have no persistent names. Hover and keyboard focus reveal the
    // one transient label; the selected node keeps it while selected. These are
    // DOM-only updates, so moving the pointer never rebuilds or refetches.
    group.addEventListener('pointerenter', () => {
      graphHoverId.set(svg, String(node.id));
      refreshTransientLabel(svg);
    });
    group.addEventListener('pointerleave', () => {
      if (graphHoverId.get(svg) !== String(node.id)) return;
      graphHoverId.delete(svg);
      refreshTransientLabel(svg);
    });
    group.addEventListener('focus', () => {
      graphFocusId.set(svg, String(node.id));
      refreshTransientLabel(svg);
    });
    group.addEventListener('blur', () => {
      if (graphFocusId.get(svg) !== String(node.id)) return;
      graphFocusId.delete(svg);
      refreshTransientLabel(svg);
    });
    group.addEventListener('keydown', event => {
      const direction = KEY_DIRECTIONS[event.key];
      if (direction) {
        event.preventDefault();
        const targetId = nearestNodeInDirection(positionedNodes(positions), node.id, direction);
        if (targetId != null) {
          focusNode(nodeById(renderedNodes, targetId));
          return;
        }
        // Radial layouts do not guarantee a neighbour inside the strict
        // cardinal cone. Fall back to deterministic order so the roving tab
        // stop always moves instead of trapping focus.
        const index = renderedNodes.findIndex(item => String(item.id) === String(node.id));
        if (index === -1 || renderedNodes.length === 0) return;
        const step = direction === 'right' || direction === 'down' ? 1 : -1;
        const next = renderedNodes[(index + step + renderedNodes.length) % renderedNodes.length];
        if (next) focusNode(next);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        if (renderedNodes[0]) focusNode(renderedNodes[0]);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        const last = renderedNodes[renderedNodes.length - 1];
        if (last) focusNode(last);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        handlers.onOpenNode?.(nodePayload(node));
      }
    });

    layers.get('nodes')?.appendChild(group);

    if (labelIds.has(String(node.id))) {
      const label = createNameLabel(
        node.name,
        pos.x,
        pos.y,
        radius,
        node.dimmed,
        undefined,
        dense ? DENSE_LABEL_MAX_CHARS : DEFAULT_LABEL_MAX_CHARS
      );
      label.setAttribute('data-label-id', String(node.id));
      layers.get('labels')?.appendChild(label);
      labels.push(label);
    }
  }

  // Remember every visible edge and its world position so a later selection can
  // draw incident edges that the dense cap left out, with no rebuild.
  /** @type {Map<string, { x: number, y: number }>} */
  const positionByKey = new Map();
  for (const [id, point] of positions) positionByKey.set(String(id), point);
  graphEdgeData.set(/** @type {SVGSVGElement} */ (svg), {
    edges: model.edges,
    positions: positionByKey,
  });

  applyGraphSelection(svg, state.selectedId ?? null);

  return { svg, transformGroup, labels };
}

/** @param {Map<string | number, { x: number, y: number }>} positions */
function positionedNodes(positions) {
  /** @type {Array<{ id: string | number, x: number, y: number }>} */
  const list = [];
  for (const [id, point] of positions) list.push({ id, x: point.x, y: point.y });
  return list;
}

/** @param {GraphModelNode[]} renderedNodes @param {string | number} id */
function nodeById(renderedNodes, id) {
  return renderedNodes.find(node => String(node.id) === String(id)) ?? null;
}

/** @param {GraphTransform | null | undefined} transform */
function normalizeTransform(transform) {
  const scale = Number.isFinite(transform?.scale) ? Number(transform?.scale) : 1;
  const tx = Number.isFinite(transform?.tx) ? Number(transform?.tx) : 0;
  const ty = Number.isFinite(transform?.ty) ? Number(transform?.ty) : 0;
  return { scale, tx, ty };
}

/**
 * @param {number} factor
 * @param {{ x: number, y: number }} anchor
 * @param {GraphTransform} current
 */
function zoomTransform(factor, anchor, current) {
  return zoomTransformAtAnchor(current, {
    factor,
    anchorX: anchor.x,
    anchorY: anchor.y,
    minScale: GRAPH_SCALE_MIN,
    maxScale: GRAPH_SCALE_MAX,
  });
}

/**
 * @param {SVGElement} svg
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ x:number, y:number, size:number }} viewBox
 */
function svgAnchorFromClient(svg, clientX, clientY, viewBox) {
  const rect = svg.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) {
    return { x: viewBox.x + viewBox.size / 2, y: viewBox.y + viewBox.size / 2 };
  }
  return {
    x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.size,
    y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.size,
  };
}

/**
 * Resolve the rendered SVG that owns a selection root, which may be the SVG
 * itself, a wrapper section, or a node group.
 *
 * @param {ParentNode} root
 * @returns {SVGSVGElement | null}
 */
function selectionSvg(root) {
  const element = /** @type {Element} */ (root);
  if (typeof element.tagName === 'string' && element.tagName.toLowerCase() === 'svg') {
    return /** @type {SVGSVGElement} */ (root);
  }
  if (typeof element.querySelector === 'function') {
    const svg = element.querySelector('svg.graph-svg');
    if (svg) return /** @type {SVGSVGElement} */ (svg);
  }
  return /** @type {SVGSVGElement | null} */ (
    /** @type {SVGElement} */ (element).ownerSVGElement ?? null
  );
}

/**
 * Update the roving tab stop and current-memory marker on an already rendered
 * graph. This is deliberately DOM-only: selecting or opening a memory must not
 * rebuild the map or issue a fetch.
 *
 * @param {ParentNode} root
 * @param {string | number | null} selectedId
 */
export function applyGraphSelection(root, selectedId) {
  const idStr = selectedId == null ? null : String(selectedId);
  const edgesLayer = root.querySelector('g[data-layer="edges"]');

  // Edges materialised for a previous selection are transient: drop them before
  // recomputing so switching or clearing a selection never leaves stale edges.
  for (const dynamic of Array.from(root.querySelectorAll('line.graph-edge.is-dynamic'))) {
    dynamic.remove();
  }
  const edges = Array.from(root.querySelectorAll('line.graph-edge'));
  const nodes = Array.from(root.querySelectorAll('g.graph-node'));

  // Dense maps keep a bounded context set, which can omit a low-degree selected
  // node's links. Materialise any missing incident edge from the full edge list
  // captured at render time. This is a DOM-only patch: no rebuild, no refetch.
  if (idStr != null && edgesLayer) {
    const svg = selectionSvg(root);
    const data = svg ? graphEdgeData.get(svg) : null;
    if (data) {
      const dense = svg?.getAttribute('data-dense') === 'true';
      /** @type {Set<string>} */
      const present = new Set();
      for (const line of edges) {
        present.add(`${line.getAttribute('data-source')}->${line.getAttribute('data-target')}`);
      }
      for (const edge of data.edges) {
        if (!edge.visible) continue;
        const source = String(edge.source);
        const target = String(edge.target);
        if (source !== idStr && target !== idStr) continue;
        const key = `${source}->${target}`;
        if (present.has(key)) continue;
        const start = data.positions.get(source);
        const end = data.positions.get(target);
        if (!start || !end) continue;

        const line = svgElement(
          'line',
          {
            x1: String(start.x),
            y1: String(start.y),
            x2: String(end.x),
            y2: String(end.y),
            'data-source': source,
            'data-target': target,
          },
          `graph-edge${dense ? ' is-dense' : ''} is-dynamic${edge.dimmed ? ' is-dimmed' : ''}`
        );
        edgesLayer.appendChild(line);
        edges.push(line);
        present.add(key);
      }
    }
  }

  /** @type {Set<string>} */
  const neighborIds = new Set();
  /** @type {Element[]} */
  const incidentEdges = [];

  // The selection is a pure DOM patch: no rebuild, no fetch, no state change.
  // Every rendered edge carries its directed endpoints, so both incoming and
  // outgoing links of the selected node are highlighted.
  for (const edge of edges) {
    const source = edge.getAttribute('data-source');
    const target = edge.getAttribute('data-target');
    const incident = idStr != null && (source === idStr || target === idStr);
    edge.classList.toggle('is-incident', incident);
    edge.classList.toggle('is-muted', idStr != null && !incident);
    if (!incident) continue;

    incidentEdges.push(edge);
    if (source != null && source !== idStr) neighborIds.add(source);
    if (target != null && target !== idStr) neighborIds.add(target);
  }

  // SVG has no z-index, so move the highlighted edges to the end of their layer
  // to paint them above the muted ones.
  if (edgesLayer) {
    for (const edge of incidentEdges) edgesLayer.appendChild(edge);
  }

  // Transient labels are re-derived from selection/focus/hover so switching or
  // clearing a selection never leaves a stale name behind.
  for (const label of Array.from(root.querySelectorAll('text.graph-label.is-selection-label'))) {
    label.remove();
  }

  for (const node of nodes) {
    const nodeId = node.getAttribute('data-node-id');
    const isSelected = idStr != null && nodeId === idStr;
    node.classList.toggle('is-selected', isSelected);
    node.classList.toggle(
      'is-neighbor',
      idStr != null && !isSelected && neighborIds.has(nodeId ?? '')
    );
    if (isSelected) node.setAttribute('aria-current', 'true');
    else node.removeAttribute('aria-current');
    if (idStr != null) node.setAttribute('tabindex', isSelected ? '0' : '-1');
  }

  // Selection is the highest-priority transient label owner, so this single
  // call adds or drops the one label with no rebuild.
  refreshTransientLabel(root);
}

/**
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @param {GraphModelNode[]} renderedNodes
 * @param {ReturnType<typeof createGraphLayout>} layout
 * @param {GraphViewHandlers} handlers
 * @returns {{ wrap: HTMLElement, zoomIn: () => void, zoomOut: () => void, reset: () => void }}
 */
function renderMap(state, model, renderedNodes, layout, handlers) {
  const wrap = element('div', 'graph-canvas-wrap');
  const viewBox = layout.viewBox;
  const zoomCenter = { x: layout.center.x, y: layout.center.y };

  /** @type {Map<string, SVGGElement>} */
  const groups = new Map();

  const transformState = normalizeTransform(state.transform);
  /** @type {SVGGElement | null} */
  let transformGroup = null;
  /** @type {SVGTextElement[]} */
  let labels = [];

  /**
   * @param {GraphTransform} next
   * @param {boolean} [notify]
   */
  function applyTransform(next, notify = true) {
    transformState.scale = next.scale;
    transformState.tx = next.tx;
    transformState.ty = next.ty;

    transformGroup?.setAttribute(
      'transform',
      `translate(${next.tx} ${next.ty}) scale(${next.scale})`
    );

    // Labels are authored in SVG units but must stay readable in screen space.
    // Compute the target screen size from zoom, then divide by the measured
    // user-unit scale (viewBox fit × zoom) so the halo and text never shrink.
    const screenSize = computeLabelFontSize(next.scale);
    const userScale = labelUserScale(svg, next.scale);
    const labelSize = computeLabelUserFontSize(screenSize, userScale);
    const currentLabels = /** @type {SVGTextElement[]} */ (
      Array.from(transformGroup?.querySelectorAll('text.graph-label') ?? [])
    );
    svg.setAttribute('data-label-font-size', String(labelSize));
    for (const label of currentLabels) applyLabelMetrics(label, labelSize);
    labels = currentLabels;

    if (notify) handlers.onTransformChange?.({ ...transformState });
  }

  /**
   * Pan emits a move per pointer event; coalesce those DOM writes to one per
   * animation frame while keeping the pending transform for gesture math.
   *
   * @type {GraphTransform | null}
   */
  let pendingPan = null;
  /** @type {number | null} */
  let panFrame = null;

  /** @param {GraphTransform} next */
  function schedulePan(next) {
    pendingPan = next;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      pendingPan = null;
      applyTransform(next);
      return;
    }
    if (panFrame != null) return;
    panFrame = globalThis.requestAnimationFrame(() => {
      panFrame = null;
      const queued = pendingPan;
      pendingPan = null;
      if (queued) applyTransform(queued);
    });
  }

  /** @param {GraphModelNode | null} node */
  function focusNode(node) {
    if (!node) return;
    const group = groups.get(String(node.id));
    if (!group) return;
    for (const other of groups.values()) other.setAttribute('tabindex', '-1');
    group.setAttribute('tabindex', '0');
    applyGraphSelection(group.ownerSVGElement ?? group, node.id);
    group.focus();
    handlers.onSelectNode?.(nodePayload(node));
  }

  const rendered = renderSvg(
    state,
    model,
    renderedNodes,
    layout,
    focusNode,
    handlers,
    transformState
  );
  const svg = /** @type {SVGSVGElement} */ (rendered.svg);
  transformGroup = rendered.transformGroup;
  labels = rendered.labels;
  applyTransform(transformState, false);
  // The SVG is usually measured before the caller appends it to the document.
  // Recompute once mounted so the viewBox fit informs the screen-space size.
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => applyTransform(transformState, false));
  }

  for (const group of svg.querySelectorAll('g.graph-node')) {
    const id = group.getAttribute('data-node-id');
    if (id != null) groups.set(id, /** @type {SVGGElement} */ (group));
  }

  // Roving tabindex: the selected node owns the tab stop, else the first one.
  const selected = state.selectedId != null ? nodeById(renderedNodes, state.selectedId) : null;
  const roving = selected ?? renderedNodes[0] ?? null;
  if (roving) {
    const group = groups.get(String(roving.id));
    group?.setAttribute('tabindex', '0');
  }

  /** @type {ReturnType<typeof createGraphInteractionState>} */
  let gesture = createGraphInteractionState();
  /**
   * A drag that starts on a node still produces a native `click` after
   * `pointerup`. Remember that the gesture panned so the capture-phase click
   * guard can swallow that click instead of opening the memory panel.
   */
  let suppressClick = false;
  /**
   * Pointer capture is taken only once a drag actually pans. Capturing on
   * `pointerdown` would retarget `pointerup`/`click` to the SVG, so a plain
   * click on a node would never reach the node's own handler.
   *
   * @type {number | null}
   */
  let capturedPointerId = null;

  svg.addEventListener(
    'wheel',
    event => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      const anchor = svgAnchorFromClient(svg, event.clientX, event.clientY, viewBox);
      applyTransform(zoomTransform(factor, anchor, transformState));
    },
    { passive: false }
  );

  svg.addEventListener('pointerdown', event => {
    // A new gesture starts here; any drag from the previous one is over.
    suppressClick = false;
    gesture = beginGraphPointerGesture(gesture, {
      pointerId: event.pointerId,
      button: event.button,
      shiftKey: event.shiftKey,
      clientX: event.clientX,
      clientY: event.clientY,
      tx: transformState.tx,
      ty: transformState.ty,
    });
  });

  svg.addEventListener('pointermove', event => {
    gesture = updateGraphPointerGesture(gesture, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });

    // Capture mid-drag so panning continues outside the SVG. A plain click
    // never reaches this phase and therefore keeps the node as the click target.
    if (gesture.phase === 'panning' && capturedPointerId !== event.pointerId) {
      capturedPointerId = event.pointerId;
      if (typeof svg.setPointerCapture === 'function') {
        try {
          svg.setPointerCapture(event.pointerId);
        } catch {
          // Environment without pointer capture support; panning still works.
        }
      }
    }

    const next = currentGraphPanTransform(gesture, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (!next) return;

    event.preventDefault();
    schedulePan({ ...transformState, tx: next.tx, ty: next.ty });
  });

  // Capture phase on the SVG runs before the node's own click handler, so a
  // pan that began and ended on a node never opens the memory panel.
  svg.addEventListener(
    'click',
    event => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    svg.addEventListener(type, event => {
      if (type === 'pointerup' && gesture.dragMoved) suppressClick = true;
      if (capturedPointerId === /** @type {PointerEvent} */ (event).pointerId) {
        capturedPointerId = null;
      }
      gesture = endGraphPointerGesture(gesture, {
        pointerId: /** @type {PointerEvent} */ (event).pointerId,
      });
    });
  }

  wrap.appendChild(svg);

  return {
    wrap,
    zoomIn: () => applyTransform(zoomTransform(1.2, zoomCenter, transformState)),
    zoomOut: () => applyTransform(zoomTransform(1 / 1.2, zoomCenter, transformState)),
    reset: () => applyTransform({ scale: 1, tx: 0, ty: 0 }),
  };
}

/**
 * @param {GraphModelNode[]} renderedNodes
 * @param {string} spaceName
 * @returns {HTMLElement}
 */
function renderMemoryList(renderedNodes, spaceName) {
  const panel = element('section', 'graph-list-panel');
  panel.setAttribute('aria-labelledby', 'graph-list-heading');

  const details = /** @type {HTMLDetailsElement} */ (element('details', 'graph-table-details'));
  // Small maps stay expanded; dense maps would otherwise add thousands of
  // pixels of table to the page, so they start collapsed behind a summary.
  details.open = renderedNodes.length <= GRAPH_TABLE_OPEN_THRESHOLD;

  const summary = element('summary', 'graph-list-heading', `Memory list (${renderedNodes.length})`);
  summary.id = 'graph-list-heading';
  details.appendChild(summary);

  const table = element('table', 'graph-memory-list');
  const thead = element('thead');
  const headRow = element('tr');
  for (const label of ['Name', 'Tier', 'Degree']) {
    const th = element('th', undefined, label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = element('tbody');
  for (const node of renderedNodes) {
    const row = element('tr');
    const nameCell = element('td');
    const link = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
    link.className = 'graph-memory-link';
    link.href = memoryHref(spaceName, node.name);
    link.textContent = node.name;
    nameCell.appendChild(link);
    row.appendChild(nameCell);
    row.appendChild(element('td', undefined, `T${node.tier}`));
    row.appendChild(element('td', undefined, String(node.degree)));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  details.appendChild(table);
  panel.appendChild(details);

  return panel;
}

/** @returns {HTMLElement} */
function renderSkeleton() {
  const skeleton = element('div', 'graph-skeleton');
  skeleton.setAttribute('aria-hidden', 'true');
  const ring = element('div', 'skeleton graph-skeleton-ring');
  skeleton.appendChild(ring);
  for (let index = 0; index < SKELETON_NODES; index += 1) {
    skeleton.appendChild(element('div', 'skeleton graph-skeleton-node'));
  }
  return skeleton;
}

/** @returns {HTMLElement} */
function renderEmpty() {
  const empty = element('div', 'graph-empty');
  empty.appendChild(element('p', 'graph-empty-message', 'No memories to map.'));
  return empty;
}

/**
 * @param {GraphViewState} state
 * @param {GraphViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderError(state, handlers) {
  const block = element('div', 'graph-error');
  block.setAttribute('role', 'alert');
  block.appendChild(
    element('p', 'graph-error-message', state.error || 'The graph could not be loaded. Try again.')
  );
  const retry = createButton(
    'graph-retry',
    'btn btn-sm btn-secondary graph-retry',
    'Try again',
    'rotate-ccw'
  );
  retry.addEventListener('click', () => handlers.onRetry?.());
  block.appendChild(retry);
  return block;
}

/**
 * @param {{ zoomIn: () => void, zoomOut: () => void, reset: () => void }} controls
 * @returns {HTMLElement}
 */
function renderToolbar(controls) {
  const toolbar = element('div', 'graph-toolbar');

  const zoomIn = createButton('btn-graph-zoom-in', 'btn btn-sm btn-ghost btn-icon', '', 'zoom-in');
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomIn.addEventListener('click', () => controls.zoomIn());

  const zoomOut = createButton(
    'btn-graph-zoom-out',
    'btn btn-sm btn-ghost btn-icon',
    '',
    'zoom-out'
  );
  zoomOut.setAttribute('aria-label', 'Zoom out');
  zoomOut.addEventListener('click', () => controls.zoomOut());

  const reset = createButton('btn-graph-reset', 'btn btn-sm btn-ghost', 'Reset zoom', 'maximize');
  reset.addEventListener('click', () => controls.reset());

  toolbar.append(zoomIn, zoomOut, reset);
  return toolbar;
}

/**
 * @param {GraphViewState} state
 * @returns {ReturnType<typeof buildGraphViewModel>}
 */
function modelFor(state) {
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  return buildGraphViewModel({
    nodes,
    links: state.edges ?? null,
    searchIds: state.searchActive ? (state.searchIds ?? []) : null,
    tierFilters: state.tierFilters ?? null,
    onlyMatches: state.onlyMatches === true,
    selectedId: state.selectedId ?? null,
  });
}

/**
 * True when the view has no persistent controls to patch: error, first-load
 * skeleton and empty are full replacements. `loading` with existing nodes (a
 * retry or refresh) keeps the controls and map chrome.
 *
 * @param {GraphViewState} state
 * @returns {boolean}
 */
function isTerminalState(state) {
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  const status = state.status ?? 'idle';
  if (status === 'error') return true;
  if (status === 'loading' && nodes.length === 0) return true;
  return nodes.length === 0;
}

/**
 * Build the replaceable graph body (truncation, toolbar, canvas, memory list).
 * The persistent controls live outside this subtree.
 *
 * @param {GraphViewState} state
 * @param {ReturnType<typeof buildGraphViewModel>} model
 * @param {GraphViewHandlers} handlers
 * @returns {HTMLElement}
 */
function buildBody(state, model, handlers) {
  const body = element('div', 'graph-body');

  if (isTruncated(state, model)) {
    body.appendChild(renderTruncation(state, model));
  }

  const visible = model.nodes.filter(node => !node.hidden);
  const layoutInput = visible.filter(node => node.tier === 1 || node.tier === 2 || node.tier === 3);
  const layout = createGraphLayout(
    /** @type {any} */ (
      layoutInput.map(node => ({
        id: node.id,
        name: node.name,
        tier: node.tier,
        links_to: node.links_to,
        linked_by: node.linked_by,
      }))
    )
  );
  const renderedNodes = visible.filter(node => layout.positions.has(node.id));

  const map = renderMap(state, model, renderedNodes, layout, handlers);
  body.appendChild(renderToolbar(map));
  body.appendChild(map.wrap);
  body.appendChild(renderMemoryList(renderedNodes, spaceNameOf(state.space)));

  return body;
}

/**
 * Render the whole accessible neural map into a fresh element.
 *
 * @param {GraphViewState} [state]
 * @param {GraphViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderGraphView(state = {}, handlers = {}) {
  const status = state.status ?? 'idle';
  const isLoading = status === 'loading';
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];

  const root = element('section', 'graph-view');
  root.setAttribute('aria-busy', String(isLoading));

  if (status === 'error') {
    root.appendChild(renderError(state, handlers));
    return root;
  }

  if (isLoading && nodes.length === 0) {
    root.appendChild(renderSkeleton());
    return root;
  }

  if (nodes.length === 0) {
    root.appendChild(renderEmpty());
    return root;
  }

  const model = modelFor(state);
  root.appendChild(buildStatus(state, model));
  root.appendChild(buildBody(state, model, handlers));

  return root;
}

/**
 * Mount the graph into a stable container and patch it on every update.
 *
 * The tier toggles, the only-matches checkbox and the `#graph-status` polite
 * live region are built once and never replaced while the graph has nodes, so
 * toggling a control preserves focus and screen-reader announcements stay
 * reliable. Only the body (truncation, toolbar, SVG, table) is rebuilt.
 *
 * @param {HTMLElement} container
 * @param {GraphViewHandlers} [handlers]
 * @returns {{ update: (state?: GraphViewState) => void, destroy: () => void }}
 */
export function createGraphView(container, handlers = {}) {
  /** @type {HTMLElement | null} */
  let mounted = null;

  /**
   * @param {GraphViewState} [state]
   */
  function update(state = {}) {
    if (isTerminalState(state)) {
      mounted = renderGraphView(state, handlers);
      container.replaceChildren(mounted);
      return;
    }

    if (
      !mounted ||
      mounted.parentNode !== container ||
      !mounted.querySelector('.graph-status-bar') ||
      !mounted.querySelector('.graph-body')
    ) {
      mounted = renderGraphView(state, handlers);
      container.replaceChildren(mounted);
      return;
    }

    const model = modelFor(state);
    mounted.setAttribute('aria-busy', String((state.status ?? 'idle') === 'loading'));

    const statusBar = mounted.querySelector('.graph-status-bar');
    if (statusBar) syncStatus(/** @type {HTMLElement} */ (statusBar), state, model);

    // Replacing the body may remove a focused toolbar control; keep focus on
    // the same id when the replacement still offers it.
    const active = /** @type {any} */ (document.activeElement);
    const restoreId =
      active && typeof active.id === 'string' && active.id && mounted.contains(active)
        ? active.id
        : null;

    const currentBody = mounted.querySelector('.graph-body');
    if (!currentBody) return;
    currentBody.replaceWith(buildBody(state, model, handlers));

    if (restoreId) {
      const replacement = /** @type {any} */ (mounted.querySelector(`[id="${restoreId}"]`));
      if (replacement && replacement !== active && typeof replacement.focus === 'function') {
        replacement.focus();
      }
    }
  }

  function destroy() {
    container.replaceChildren();
    mounted = null;
  }

  return { update, destroy };
}
