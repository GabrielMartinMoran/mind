// @ts-check
/**
 * Memory list keyboard navigation.
 *
 * One document listener walks the visible memory card links with
 * ArrowDown/ArrowUp/Home/End. It only acts when the focused element is a card
 * link inside the visible list view, so the topbar search shortcuts, the
 * view-toggle Home/End handling and native select/input key behavior keep
 * working untouched. Enter is never intercepted; the anchor activates natively.
 */

export const MEMORY_CARD_LINK_SELECTOR = '.memory-card-link';

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * Map a navigation key to the next card index.
 *
 * `-1` means "do not move", so the caller can leave the event alone and let the
 * page scroll at the edges.
 *
 * @param {{ key: string, index: number, count: number }} input
 * @returns {number}
 */
export function resolveCardNavigation(input) {
  const { key, index, count } = input;
  if (!Number.isFinite(count) || count <= 0) return -1;

  if (key === 'Home') {
    return index === 0 ? -1 : 0;
  }
  if (key === 'End') {
    return index === count - 1 ? -1 : count - 1;
  }
  if (key === 'ArrowDown') {
    return index + 1 < count ? index + 1 : -1;
  }
  if (key === 'ArrowUp') {
    return index - 1 >= 0 ? index - 1 : -1;
  }

  return -1;
}

/**
 * Whether an element (or any ancestor) is hidden through the shared `.hidden`
 * utility or the `hidden` attribute. `offsetParent` is unreliable in DOM test
 * environments, so the check is structural.
 *
 * @param {Element | null | undefined} element
 * @returns {boolean}
 */
function isHidden(element) {
  let node = /** @type {any} */ (element);
  while (node) {
    if (typeof node.classList?.contains === 'function' && node.classList.contains('hidden')) {
      return true;
    }
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * @typedef {Object} MemoryKeyboardOptions
 * @property {Document} [document] Document that owns the list.
 * @property {() => HTMLElement | null} [getListRoot] Reads the list container.
 * @property {(root: HTMLElement) => boolean} [isVisible] Whether the list is on screen.
 */

/**
 * @typedef {Object} MemoryKeyboardController
 * @property {() => void} destroy Removes the document listener.
 */

/**
 * Bind the list keyboard navigation to a document.
 *
 * @param {MemoryKeyboardOptions} [options]
 * @returns {MemoryKeyboardController}
 */
export function setupMemoryKeyboard(options = {}) {
  const doc = options.document ?? /** @type {Document} */ (globalThis.document);
  const getListRoot =
    options.getListRoot ??
    (() => /** @type {HTMLElement | null} */ (doc.getElementById('list-view')));
  const isVisible = options.isVisible ?? (root => !isHidden(root));

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

    const root = getListRoot();
    if (!root || !isVisible(root)) return;

    const active = doc.activeElement;
    if (!(active instanceof doc.defaultView.Element)) return;
    if (!active.matches(MEMORY_CARD_LINK_SELECTOR)) return;
    if (!root.contains(active)) return;

    const links = Array.from(root.querySelectorAll(MEMORY_CARD_LINK_SELECTOR));
    const index = links.indexOf(active);
    if (index < 0) return;

    const nextIndex = resolveCardNavigation({ key: event.key, index, count: links.length });
    if (nextIndex < 0) return;

    const next = /** @type {HTMLElement | undefined} */ (links[nextIndex]);
    if (!next) return;

    event.preventDefault();
    next.focus();
  }

  doc.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      doc.removeEventListener('keydown', onKeyDown);
    },
  };
}
