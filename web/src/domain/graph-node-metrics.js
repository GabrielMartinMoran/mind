// @ts-check
/**
 * Pure per-node visual metrics for the neural map.
 *
 * A node is drawn as a circle whose radius encodes the combined number of
 * incoming and outgoing links, with the degree number centered inside it. These
 * functions are deterministic and DOM-free so the view, the layout math and the
 * tests all agree on the same numbers.
 */

const NODE_RADIUS_MIN = 8.5;
const NODE_RADIUS_MAX = 21;
const NODE_RADIUS_SCALE = 3.5;
const DEGREE_FONT_MIN = 8;
const DEGREE_FONT_MAX = 13;
/**
 * Approximate advance width of a digit as a fraction of the font size. Digits
 * are narrower than the average glyph, so this leaves room for the circle
 * stroke while keeping the label readable.
 */
const DIGIT_WIDTH_RATIO = 0.62;

/** @typedef {{ min?: number, max?: number, scale?: number }} NodeRadiusOptions */
/** @typedef {{ links_to?: readonly unknown[] | null, linked_by?: readonly unknown[] | null }} DegreeNode */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Combined incoming + outgoing link count for a node.
 *
 * @param {DegreeNode | null | undefined} node
 * @returns {number}
 */
function nodeDegree(node) {
  const outgoing = Array.isArray(node?.links_to) ? node.links_to.length : 0;
  const incoming = Array.isArray(node?.linked_by) ? node.linked_by.length : 0;
  return outgoing + incoming;
}

/**
 * Circle radius for a degree. Uses a square-root curve: low-degree nodes stay
 * compact, medium-degree nodes grow quickly, and dense hubs are capped so a
 * single 41-link node cannot swallow the map.
 *
 * With the defaults: degree 0 ≈ 8.5, degree 4 ≈ 15.5, degree 41 = 21 (cap).
 *
 * @param {number} degree
 * @param {NodeRadiusOptions} [options]
 * @returns {number}
 */
function nodeRadius(degree, options = {}) {
  const min = Number.isFinite(options.min) ? /** @type {number} */ (options.min) : NODE_RADIUS_MIN;
  const max = Number.isFinite(options.max) ? /** @type {number} */ (options.max) : NODE_RADIUS_MAX;
  const scale = Number.isFinite(options.scale)
    ? /** @type {number} */ (options.scale)
    : NODE_RADIUS_SCALE;
  const safeDegree = Number.isFinite(degree) ? Math.max(0, degree) : 0;
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return clamp(lower + scale * Math.sqrt(safeDegree), lower, upper);
}

/**
 * Plain text shown inside the circle, for example `"0"`, `"4"` or `"41"`.
 *
 * @param {number} degree
 * @returns {string}
 */
function nodeDegreeLabel(degree) {
  const safeDegree = Number.isFinite(degree) ? Math.max(0, Math.trunc(degree)) : 0;
  return String(safeDegree);
}

/**
 * Largest font size that keeps a `digits`-wide number inside a circle of the
 * given radius. The width budget is clamped to `[8, 13]` so tiny circles stay
 * legible and large hubs do not grow oversized text.
 *
 * @param {number} radius
 * @param {number} [digits]
 * @returns {number}
 */
function nodeDegreeFontSize(radius, digits = 1) {
  const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const digitCount = Number.isFinite(digits) ? Math.max(1, Math.trunc(digits)) : 1;

  // Keep the glyphs clear of the 1.5px circle stroke.
  const availableWidth = Math.max(1, safeRadius * 2 - 4);
  const widthBound = availableWidth / (digitCount * DIGIT_WIDTH_RATIO);
  const heightBound = safeRadius * 1.4;

  return clamp(Math.min(widthBound, heightBound), DEGREE_FONT_MIN, DEGREE_FONT_MAX);
}

export { nodeDegree, nodeDegreeFontSize, nodeDegreeLabel, nodeRadius };
