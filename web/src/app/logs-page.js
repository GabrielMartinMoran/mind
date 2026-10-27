// @ts-check
/**
 * Logs page composition layer.
 *
 * Mounts the filter bar and live controls once, keeps a persistent
 * `#logs-status` polite live region, and replaces only the result body (table,
 * details, pagination, loading/empty/error) when state changes. Focus inside
 * the replaced body is restored by a stable id or `data-focus-key`, and a
 * filter the user is editing is never overwritten by a poll.
 *
 * It performs no fetching and owns no global state: app.js supplies the state
 * and the intent handlers.
 */

import {
  logsLiveStateText,
  logsStatusText,
  renderLogsBody,
  renderLogsFilters,
  renderLogsLiveBar,
} from '../views/logs-view.js';

const ID_PREFIX = 'id:';
const KEY_PREFIX = 'key:';

/**
 * @typedef {import('../views/logs-view.js').LogsViewHandlers} LogsViewHandlers
 * @typedef {import('../views/logs-view.js').LogsViewState} LogsViewState
 */

/**
 * @typedef {Object} LogsPageOptions
 * @property {HTMLElement | null | undefined} [root] Container that receives the page.
 * @property {() => LogsViewState} [getState] Reads the current logs slice.
 * @property {LogsViewHandlers} [handlers] User-intent callbacks.
 * @property {Document} [document] Document used to create page nodes.
 */

/**
 * @typedef {Object} LogsPage
 * @property {() => HTMLElement | null | undefined} mount
 * @property {() => void} update
 * @property {() => void} destroy
 */

/**
 * @param {Element | null} node
 * @returns {string | null}
 */
function focusKey(node) {
  if (!node) return null;
  if (node.id) return `${ID_PREFIX}${node.id}`;
  const key = node.getAttribute('data-focus-key');
  if (key) return `${KEY_PREFIX}${key}`;
  return null;
}

/**
 * @param {LogsPageOptions} [options]
 * @returns {LogsPage}
 */
export function createLogsPage(options = {}) {
  const { root, getState, handlers = {} } = options;
  const doc = options.document ?? globalThis.document;

  let mounted = false;
  let destroyed = false;
  /** @type {HTMLElement | null} */
  let filterBar = null;
  /** @type {HTMLElement | null} */
  let liveBar = null;
  /** @type {HTMLInputElement | null} */
  let liveToggle = null;
  /** @type {HTMLElement | null} */
  let liveState = null;
  /** @type {HTMLElement | null} */
  let section = null;
  /** @type {HTMLElement | null} */
  let region = null;
  /** @type {HTMLElement | null} */
  let statusNode = null;
  /** @type {HTMLElement | null} */
  let body = null;
  /**
   * Filter controls with an in-progress edit. A control is dirty from `input`
   * until it commits (`change`) or loses focus; `syncFilters` must not
   * overwrite its value while it is in this set, or a poll could erase text the
   * user is still typing.
   * @type {Set<HTMLElement>}
   */
  const dirtyControls = new Set();

  /** @param {Event} event */
  function markControlDirty(event) {
    const target = /** @type {HTMLElement | null} */ (event.target);
    if (target) dirtyControls.add(target);
  }

  /** @param {Event} event */
  function clearControlDirty(event) {
    const target = /** @type {HTMLElement | null} */ (event.target);
    if (target) dirtyControls.delete(target);
  }

  /**
   * @typedef {{ id: string, key: keyof NonNullable<LogsViewState['filters']> }} FilterBinding
   */

  /** @type {FilterBinding[]} */
  const filterBindings = [
    { id: 'log-filter-source', key: 'source' },
    { id: 'log-filter-operation', key: 'operation' },
    { id: 'log-filter-level', key: 'level' },
    { id: 'log-filter-search', key: 'search' },
    { id: 'log-filter-from', key: 'from' },
    { id: 'log-filter-to', key: 'to' },
  ];

  /**
   * Reconcile persistent filter controls with state. A control that is dirty or
   * currently focused keeps its value so an async response or live poll cannot
   * clobber an uncommitted edit.
   *
   * @param {LogsViewState} state
   */
  function syncFilters(state) {
    if (!filterBar) return;
    const filters = state.filters ?? {};
    const active = doc.activeElement;

    for (const { id, key } of filterBindings) {
      const control = /** @type {HTMLInputElement | HTMLSelectElement | null} */ (
        filterBar.querySelector(`#${id}`)
      );
      if (!control) continue;
      if (dirtyControls.has(control) || control === active) continue;
      const value = typeof filters[key] === 'string' ? String(filters[key]) : '';
      if (control.value !== value) control.value = value;
    }
  }

  /** @param {LogsViewState} state */
  function syncLiveBar(state) {
    if (liveToggle) {
      const checked = state.live === true;
      if (liveToggle.checked !== checked) liveToggle.checked = checked;
    }
    if (liveState) {
      const text = logsLiveStateText(state);
      if (liveState.textContent !== text) liveState.textContent = text;
    }
  }

  /** @param {LogsViewState} state */
  function syncStatus(state) {
    const busy = state.status === 'loading';
    const text = logsStatusText(state);
    if (statusNode && statusNode.textContent !== text) statusNode.textContent = text;
    statusNode?.setAttribute('aria-busy', String(busy));
    region?.setAttribute('aria-busy', String(busy));
    section?.setAttribute('aria-busy', String(busy));
  }

  /**
   * @param {string} key
   * @returns {HTMLElement | null}
   */
  function findElementByKey(key) {
    if (!root) return null;
    if (key.startsWith(ID_PREFIX)) {
      return /** @type {HTMLElement | null} */ (doc.getElementById(key.slice(ID_PREFIX.length)));
    }
    const dataKey = key.slice(KEY_PREFIX.length);
    for (const node of root.querySelectorAll('[data-focus-key]')) {
      if (node.getAttribute('data-focus-key') === dataKey) return /** @type {HTMLElement} */ (node);
    }
    return null;
  }

  /**
   * Focus inside the replaced body is restored by a stable key. If the node is
   * gone, focus moves to the persistent region rather than a detached element.
   *
   * @param {Element | null} active
   * @param {boolean} focusWasInBody
   */
  function restoreFocus(active, focusWasInBody) {
    if (!focusWasInBody || !active) return;
    if (active.isConnected !== false) return;

    const key = focusKey(active);
    const replacement = key ? findElementByKey(key) : null;
    if (replacement) {
      replacement.focus();
    } else {
      region?.focus();
    }
  }

  /** @param {LogsViewState} state */
  function applyState(state) {
    if (!filterBar || !body || !section) return;

    const active = doc.activeElement;
    const focusWasInBody = Boolean(active && body.contains(active));

    syncFilters(state);
    syncLiveBar(state);
    syncStatus(state);
    body.replaceChildren(renderLogsBody(state, handlers));

    restoreFocus(active, focusWasInBody);
  }

  function mount() {
    if (!root || mounted || destroyed) return root;
    mounted = true;

    const state = getState?.() ?? {};
    filterBar = renderLogsFilters(state, handlers);
    filterBar.addEventListener('input', markControlDirty);
    filterBar.addEventListener('change', clearControlDirty);
    filterBar.addEventListener('focusout', clearControlDirty);

    liveBar = renderLogsLiveBar(state, handlers);
    liveToggle = /** @type {HTMLInputElement | null} */ (
      liveBar.querySelector('#logs-live-toggle')
    );
    liveState = /** @type {HTMLElement | null} */ (liveBar.querySelector('.logs-live-state'));

    section = doc.createElement('section');
    section.className = 'logs-view';
    section.setAttribute('aria-labelledby', 'logs-heading');

    region = doc.createElement('div');
    region.className = 'logs-region';
    region.id = 'logs-region';
    region.tabIndex = -1;

    statusNode = doc.createElement('p');
    statusNode.className = 'logs-status';
    statusNode.id = 'logs-status';
    statusNode.setAttribute('role', 'status');
    statusNode.setAttribute('aria-live', 'polite');

    body = doc.createElement('div');
    body.className = 'logs-body';

    region.appendChild(statusNode);
    region.appendChild(body);
    section.appendChild(filterBar);
    section.appendChild(liveBar);
    section.appendChild(region);
    root.replaceChildren(section);

    applyState(state);
    return root;
  }

  function update() {
    if (destroyed) return;
    if (!mounted) {
      mount();
      return;
    }
    applyState(getState?.() ?? {});
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dirtyControls.clear();
    filterBar = null;
    liveBar = null;
    liveToggle = null;
    liveState = null;
    section = null;
    region = null;
    statusNode = null;
    body = null;
    mounted = false;
    root?.replaceChildren();
  }

  return { mount, update, destroy };
}
