// @ts-check
/**
 * Search keyboard shortcuts.
 *
 * One document listener owns the search shortcuts so no other module has to
 * duplicate them:
 *
 * - `/` focuses the open space's search input unless the user is typing or
 *   pressing a modifier. Search only exists inside a space, so on home or logs
 *   `getSearchInput` returns null and the shortcut is inert.
 * - ArrowDown/ArrowUp, Home and End walk the result links in document order.
 * - Escape clears the input query or returns focus from a result to the input.
 *
 * Navigation only starts from the search input or a result link, so controls
 * with their own key handling (for example the list/map view toggle) keep their
 * Home/End/Arrow behavior. Only result navigation and Escape-on-result require
 * a visible search surface; `/` and Escape-in-input always work, and native
 * Enter activation on a result anchor is left untouched.
 */

export const RESULT_LINK_SELECTOR = '.search-result-link';

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * Whether a key event target is a text-entry control where `/` should type a
 * character instead of focusing search.
 *
 * Only text-entry surfaces count: inputs, textareas, selects, and
 * contenteditable regions. Buttons and other non-text controls are excluded, so
 * `/` still focuses search after focus returns to a button (for example when a
 * drawer closes).
 *
 * @param {EventTarget | null | undefined} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const element = /** @type {any} */ (target);

  if (element.isContentEditable === true) return true;

  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }

  if (typeof element.getAttribute === 'function') {
    return element.getAttribute('contenteditable') === 'true';
  }

  return false;
}

/**
 * Map a navigation key to the next result index.
 *
 * `index` is the active result index, or `-1` when focus is on the search
 * input. Returning `-1` means "do not move", which lets the caller avoid
 * calling `preventDefault` on a key that would otherwise scroll the page.
 *
 * @param {{ key: string, index: number, count: number }} input
 * @returns {number}
 */
export function resolveResultNavigation(input) {
  const { key, index, count } = input;
  if (!Number.isFinite(count) || count <= 0) return -1;

  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;

  if (key === 'ArrowDown') {
    if (index < 0) return 0;
    return index + 1 < count ? index + 1 : -1;
  }

  if (key === 'ArrowUp') {
    if (index < 0) return count - 1;
    return index - 1 >= 0 ? index - 1 : -1;
  }

  return -1;
}

/**
 * @typedef {Object} SearchKeyboardOptions
 * @property {Document} [document] Document that owns the input and results.
 * @property {() => HTMLElement | null} [getSearchInput] Reads the search input.
 * @property {() => ParentNode | null} [getResultsRoot] Reads the results root.
 * @property {() => boolean} [isSearchVisible] Whether search is on screen.
 * @property {() => void} [onClearQuery] Clears the active query.
 */

/**
 * @typedef {Object} SearchKeyboardController
 * @property {() => void} destroy Removes the document listener.
 */

/**
 * Bind the search shortcuts to a document.
 *
 * @param {SearchKeyboardOptions} [options]
 * @returns {SearchKeyboardController}
 */
export function setupSearchKeyboard(options = {}) {
  const doc = options.document ?? /** @type {Document} */ (globalThis.document);
  const getSearchInput =
    options.getSearchInput ??
    (() => /** @type {HTMLElement | null} */ (doc.getElementById('space-search')));
  const getResultsRoot = options.getResultsRoot ?? (() => doc.getElementById('space-search-view'));
  const isSearchVisible = options.isSearchVisible ?? (() => true);
  const onClearQuery = options.onClearQuery ?? (() => {});

  /** @returns {HTMLElement[]} */
  function resultLinks() {
    const root = getResultsRoot();
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll(RESULT_LINK_SELECTOR));
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const input = getSearchInput();
    if (!input) return;

    const target = /** @type {Element | null} */ (event.target);
    const active = /** @type {Element | null} */ (doc.activeElement);

    if (event.key === '/') {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(target)) return;
      event.preventDefault();
      input.focus();
      return;
    }

    if (event.key === 'Escape') {
      if (target === input || active === input) {
        event.preventDefault();
        onClearQuery();
        /** @type {HTMLInputElement} */ (input).value = '';
        input.focus();
        return;
      }

      if (!isSearchVisible()) return;

      if (active && active !== input && active.matches(RESULT_LINK_SELECTOR)) {
        event.preventDefault();
        input.focus();
      }
      return;
    }

    if (!NAVIGATION_KEYS.has(event.key)) return;
    if (!isSearchVisible()) return;

    const links = resultLinks();
    const fromInput = active === input;
    const activeIndex = active ? links.indexOf(/** @type {HTMLElement} */ (active)) : -1;
    if (!fromInput && activeIndex < 0) return;

    const nextIndex = resolveResultNavigation({
      key: event.key,
      index: fromInput ? -1 : activeIndex,
      count: links.length,
    });
    if (nextIndex < 0 || nextIndex === activeIndex) return;

    const next = links[nextIndex];
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
