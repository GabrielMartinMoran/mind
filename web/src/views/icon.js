// @ts-check
/**
 * Shared icon helper for the local Lucide sprite.
 *
 * The sprite is a static, curated subset committed at `web/assets/icons.svg`
 * (Lucide 0.547.0). Icons are decorative: callers own the accessible name of
 * the surrounding button/link, so every generated SVG is hidden from assistive
 * technology and never becomes a tab stop. Markup is built with DOM APIs only;
 * icon names are validated against a frozen allowlist before they reach a
 * `<use>` href.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Root-absolute path served from `web/assets/icons.svg` on deep routes. */
export const ICON_SPRITE_PATH = '/assets/icons.svg';

/** Curated icon-map values from the approved 00030 plan. */
export const ICON_NAMES = Object.freeze([
  'menu',
  'x',
  'arrow-left',
  'folder-plus',
  'file-text',
  'layout-grid',
  'file-plus',
  'trash-2',
  'list',
  'network',
  'tag',
  'filter-x',
  'check',
  'arrow-up',
  'arrow-down',
  'pin',
  'pencil',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'zoom-in',
  'zoom-out',
  'maximize',
  'rotate-ccw',
  'circle-check',
  'circle-alert',
  'triangle-alert',
]);

/** @typedef {'sm' | 'md'} IconSize */
/** @typedef {{ size?: IconSize, document?: Document }} IconOptions */

const ICON_SIZES = Object.freeze(['sm', 'md']);

/**
 * Build one decorative icon that references the shared sprite.
 *
 * @param {string} name Allowlisted icon name, without the `icon-` prefix.
 * @param {IconOptions} [options]
 * @returns {SVGSVGElement}
 */
export function createIcon(name, options = {}) {
  const document =
    options.document ??
    (typeof globalThis.document === 'undefined' ? undefined : globalThis.document);
  if (!document) throw new Error('createIcon requires a document');

  if (!ICON_NAMES.includes(name)) {
    throw new RangeError(`Unknown icon name: ${String(name)}`);
  }

  const size = options.size ?? 'md';
  if (!ICON_SIZES.includes(size)) {
    throw new RangeError(`Unknown icon size: ${String(size)}`);
  }

  const icon = /** @type {SVGSVGElement} */ (document.createElementNS(SVG_NAMESPACE, 'svg'));
  icon.setAttribute('class', size === 'sm' ? 'icon icon-sm' : 'icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');

  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `${ICON_SPRITE_PATH}#icon-${name}`);
  icon.appendChild(use);

  return icon;
}
