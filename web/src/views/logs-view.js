// @ts-check
/**
 * Pure logs view renderer for the existing `#logs-page` container.
 *
 * `renderLogsView` builds the filter bar, live controls, the accessible logs
 * table with expandable detail rows, pagination and the loading/empty/error
 * states. It never fetches, reads globals or mutates state: app.js supplies the
 * state and receives user intent through the handlers. All log content is
 * written with `textContent`, so user data can never become markup.
 */

import {
  LOG_LEVELS,
  LOG_SOURCES,
  MAX_ROWS,
  capLogRows,
  describeLogAgent,
  formatDuration,
  formatLogTime,
  paginationRange,
  toIsoDateTime,
} from '../domain/logs-model.js';

import { createIcon } from './icon.js';

const SKELETON_ROWS = 5;
const MAX_PAGE_BUTTONS = 7;

// Shared domain typedefs (single source of truth in logs-model.js).
/** @typedef {import('../domain/logs-model.js').LogRecordLike} LogRecordLike */
/** @typedef {import('../domain/logs-model.js').LogsFilters} LogsFilters */

/**
 * @typedef {Object} LogsViewState
 * @property {LogRecordLike[]} [logs]
 * @property {number} [total]
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {LogsFilters} [filters]
 * @property {boolean} [live]
 * @property {'idle' | 'loading' | 'success' | 'error'} [status]
 * @property {string | null} [error]
 * @property {string | number | null} [expandedId]
 * @property {boolean} [visible]
 * @property {string} [lastUpdatedAt]
 * @property {number} [dropped]
 */

/**
 * @typedef {Object} LogsViewHandlers
 * @property {(name: string, value: string | number | null) => void} [onFilterChange]
 * @property {() => void} [onClearFilters]
 * @property {(page: number) => void} [onPageChange]
 * @property {(enabled: boolean) => void} [onLiveChange]
 * @property {() => void} [onRetry]
 * @property {(logId: number | string) => void} [onToggleDetails]
 */

/** @typedef {{ value: string, label: string }} SelectOption */

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
 * @param {string} id
 * @param {SelectOption[]} options
 * @param {string} selected
 * @returns {HTMLSelectElement}
 */
function createSelect(id, options, selected) {
  const select = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  select.id = id;
  select.className = 'select logs-filter-control';

  for (const option of options) {
    const node = /** @type {HTMLOptionElement} */ (document.createElement('option'));
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = selected;
  return select;
}

/**
 * @param {string} labelText
 * @param {string} controlId
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function createField(labelText, controlId, control) {
  const field = element('div', 'form-field logs-filter');
  const label = /** @type {HTMLLabelElement} */ (document.createElement('label'));
  label.className = 'form-label';
  label.htmlFor = controlId;
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(control);
  return field;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {LogsFilters | undefined} filters
 * @returns {boolean}
 */
function hasActiveFilters(filters) {
  if (!filters) return false;
  return Boolean(
    text(filters.source).trim() ||
    text(filters.operation).trim() ||
    text(filters.level).trim() ||
    text(filters.search).trim() ||
    text(filters.from).trim() ||
    text(filters.to).trim()
  );
}

/**
 * Pretty-print a stringified JSON payload. Non-JSON text is returned verbatim
 * and everything is rendered as text, never as markup.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * @param {LogRecordLike} log
 * @returns {string}
 */
function logKey(log) {
  return String(log.id ?? '');
}

/**
 * @param {number} page
 * @param {number} pages
 * @returns {number[]}
 */
function pageNumbers(page, pages) {
  if (pages <= 0) return [];
  if (pages <= MAX_PAGE_BUTTONS) {
    return Array.from({ length: pages }, (_, index) => index + 1);
  }
  const start = Math.max(1, Math.min(page - 3, pages - (MAX_PAGE_BUTTONS - 1)));
  return Array.from({ length: MAX_PAGE_BUTTONS }, (_, index) => start + index);
}

/**
 * @param {LogsViewState} state
 * @param {LogRecordLike[]} logs
 * @returns {string}
 */
function liveStateText(state, logs) {
  if (state.live !== true) return 'Live mode off';
  if (state.visible === false) return 'Paused while tab is hidden';

  const updated = formatLogTime(state.lastUpdatedAt) || formatLogTime(logs[0]?.timestamp);
  return updated ? `Live · last updated ${updated}` : 'Live · waiting for new entries';
}

/**
 * @param {LogsViewState} state
 * @param {number} total
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function statusText(state, total, from, to) {
  if (state.status === 'loading' && (state.logs?.length ?? 0) === 0) return 'Loading logs…';
  if (state.status === 'error') return 'Logs could not be loaded';
  if (total === 0) return '0 logs';
  return `Showing ${from}–${to} of ${total} logs`;
}

/**
 * Build the filter bar. The composition layer mounts this once so focus and
 * in-progress edits survive state updates.
 *
 * @param {LogsViewState} [state]
 * @param {LogsViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderLogsFilters(state = {}, handlers = {}) {
  const filters = state.filters ?? {};
  const container = element('section', 'logs-filters');
  container.setAttribute('aria-labelledby', 'logs-filters-heading');

  const heading = element('h2', 'visually-hidden', 'Log filters');
  heading.id = 'logs-filters-heading';
  container.appendChild(heading);

  const grid = element('div', 'logs-filter-grid');

  const sourceSelect = createSelect(
    'log-filter-source',
    [
      { value: '', label: 'All sources' },
      ...LOG_SOURCES.map(source => ({ value: source, label: source.toUpperCase() })),
    ],
    text(filters.source)
  );
  sourceSelect.addEventListener('change', () => {
    handlers.onFilterChange?.('source', sourceSelect.value || null);
  });
  grid.appendChild(createField('Source', 'log-filter-source', sourceSelect));

  const operationInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  operationInput.type = 'text';
  operationInput.id = 'log-filter-operation';
  operationInput.className = 'input logs-filter-control';
  operationInput.autocomplete = 'off';
  operationInput.placeholder = 'e.g. add_memory';
  operationInput.value = text(filters.operation);
  operationInput.addEventListener('change', () => {
    handlers.onFilterChange?.('operation', operationInput.value.trim());
  });
  grid.appendChild(createField('Operation', 'log-filter-operation', operationInput));

  const levelSelect = createSelect(
    'log-filter-level',
    [
      { value: '', label: 'All levels' },
      ...LOG_LEVELS.map(level => ({
        value: level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    ],
    text(filters.level)
  );
  levelSelect.addEventListener('change', () => {
    handlers.onFilterChange?.('level', levelSelect.value || null);
  });
  grid.appendChild(createField('Level', 'log-filter-level', levelSelect));

  const searchInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  searchInput.type = 'search';
  searchInput.id = 'log-filter-search';
  searchInput.className = 'input logs-filter-control';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = 'Search logs';
  searchInput.value = text(filters.search);
  searchInput.addEventListener('change', () => {
    handlers.onFilterChange?.('search', searchInput.value.trim());
  });
  grid.appendChild(createField('Search', 'log-filter-search', searchInput));

  const fromInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  fromInput.type = 'date';
  fromInput.id = 'log-filter-from';
  fromInput.className = 'input logs-filter-control';
  fromInput.value = text(filters.from);
  fromInput.addEventListener('change', () => {
    handlers.onFilterChange?.('from', fromInput.value);
  });
  grid.appendChild(createField('From', 'log-filter-from', fromInput));

  const toInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  toInput.type = 'date';
  toInput.id = 'log-filter-to';
  toInput.className = 'input logs-filter-control';
  toInput.value = text(filters.to);
  toInput.addEventListener('change', () => {
    handlers.onFilterChange?.('to', toInput.value);
  });
  grid.appendChild(createField('To', 'log-filter-to', toInput));

  container.appendChild(grid);

  const actions = element('div', 'logs-filter-actions');
  const clear = createButton(
    'logs-clear-filters',
    'btn btn-sm btn-ghost logs-clear-filters',
    'Clear filters',
    'filter-x'
  );
  clear.addEventListener('click', () => handlers.onClearFilters?.());
  actions.appendChild(clear);
  container.appendChild(actions);

  return container;
}

/**
 * The live-mode status sentence, exported so the composition layer can update
 * the persistent live region without rebuilding it.
 *
 * @param {LogsViewState} state
 * @returns {string}
 */
export function logsLiveStateText(state) {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  return liveStateText(state, logs);
}

/**
 * The result-count status sentence, exported so the composition layer can
 * update the persistent `#logs-status` node in place.
 *
 * @param {LogsViewState} state
 * @returns {string}
 */
export function logsStatusText(state) {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const total = Number.isFinite(state.total) ? Math.max(0, Number(state.total)) : logs.length;
  const range = paginationRange({ total, limit: state.limit, offset: state.offset });
  return statusText(state, total, range.from, range.to);
}

/**
 * Build the live-mode bar. Mounted once by the composition layer so the
 * checkbox and its polite status text keep their identity across updates.
 *
 * @param {LogsViewState} [state]
 * @param {LogsViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderLogsLiveBar(state = {}, handlers = {}) {
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const bar = element('div', 'logs-live-bar');

  const label = /** @type {HTMLLabelElement} */ (document.createElement('label'));
  label.className = 'checkbox logs-live-toggle';
  label.htmlFor = 'logs-live-toggle';

  const checkbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  checkbox.type = 'checkbox';
  checkbox.id = 'logs-live-toggle';
  checkbox.checked = state.live === true;
  checkbox.addEventListener('change', () => handlers.onLiveChange?.(checkbox.checked));

  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(' Live'));
  bar.appendChild(label);

  const stateText = element('span', 'logs-live-state', liveStateText(state, logs));
  stateText.setAttribute('role', 'status');
  stateText.setAttribute('aria-live', 'polite');
  bar.appendChild(stateText);

  return bar;
}

/**
 * @param {LogRecordLike} log
 * @returns {HTMLTableRowElement}
 */
function renderDetailsRow(log) {
  const row = /** @type {HTMLTableRowElement} */ (document.createElement('tr'));
  row.className = 'logs-details-row';
  row.id = `log-details-${logKey(log).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const cell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  cell.colSpan = 8;

  const list = element('dl', 'logs-details');

  /**
   * @param {string} label
   * @param {unknown} value
   */
  const add = (label, value) => {
    const group = element('div', 'logs-detail');
    group.appendChild(element('dt', 'logs-detail-label', label));
    const description = element('dd', 'logs-detail-value');
    const pre = element('pre', 'logs-detail-pre', formatValue(value));
    description.appendChild(pre);
    group.appendChild(description);
    list.appendChild(group);
  };

  add('Input', log.input_data);
  add('Output', log.output_data);
  if (log.error_message) add('Error', log.error_message);
  if (log.caller_info) add('Caller', log.caller_info);

  cell.appendChild(list);
  row.appendChild(cell);
  return row;
}

/**
 * @param {LogRecordLike} log
 * @param {LogsViewState} state
 * @param {LogsViewHandlers} handlers
 * @returns {HTMLTableRowElement}
 */
function renderLogRow(log, state, handlers) {
  const key = logKey(log);
  const expanded = key !== '' && String(state.expandedId) === key;

  const row = /** @type {HTMLTableRowElement} */ (document.createElement('tr'));
  row.className = 'logs-row';
  if (log.id !== undefined) row.dataset.logId = key;

  const timeCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  timeCell.className = 'logs-cell-time';
  const time = element('time', 'logs-time', formatLogTime(log.timestamp) || '—');
  const isoTime = toIsoDateTime(log.timestamp);
  if (isoTime) time.setAttribute('datetime', isoTime);
  timeCell.appendChild(time);
  row.appendChild(timeCell);

  const sourceCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  const source = text(log.source);
  sourceCell.appendChild(
    element('span', `logs-source logs-source-${source || 'unknown'}`, source || '—')
  );
  row.appendChild(sourceCell);

  const agentCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  agentCell.className = 'logs-agent-cell';
  const agentInfo = describeLogAgent(log.caller_info);
  if (agentInfo.agent) {
    const badge = element('span', 'logs-agent', agentInfo.label);
    badge.setAttribute('title', agentInfo.raw);
    agentCell.appendChild(badge);
  } else {
    const none = element('span', 'logs-agent logs-agent-none');
    none.setAttribute('title', 'No agent recorded');
    const dash = element('span', undefined, '—');
    dash.setAttribute('aria-hidden', 'true');
    none.appendChild(dash);
    none.appendChild(element('span', 'visually-hidden', 'No agent recorded'));
    agentCell.appendChild(none);
  }
  row.appendChild(agentCell);

  const operationCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  operationCell.className = 'logs-operation';
  operationCell.textContent = text(log.operation) || '—';
  row.appendChild(operationCell);

  const levelCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  const level = text(log.level);
  levelCell.appendChild(
    element('span', `logs-level logs-level-${level || 'unknown'}`, level || '—')
  );
  row.appendChild(levelCell);

  const durationCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  durationCell.className = 'logs-duration';
  durationCell.textContent = formatDuration(log.duration_ms);
  row.appendChild(durationCell);

  const summaryCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  summaryCell.className = 'logs-summary';
  summaryCell.textContent = text(log.error_message) || '—';
  row.appendChild(summaryCell);

  const actionCell = /** @type {HTMLTableCellElement} */ (document.createElement('td'));
  actionCell.className = 'logs-cell-actions';
  const toggle = createButton(
    '',
    'btn btn-sm btn-ghost logs-details-toggle',
    expanded ? 'Hide details' : 'Details',
    expanded ? 'chevron-down' : 'chevron-right'
  );
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('data-focus-key', `log-details-toggle:${key}`);
  toggle.setAttribute('aria-controls', `log-details-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
  toggle.setAttribute(
    'aria-label',
    `${expanded ? 'Hide' : 'Show'} details for ${text(log.operation) || 'log'}`
  );
  toggle.addEventListener('click', () => {
    if (log.id !== undefined) handlers.onToggleDetails?.(log.id);
  });
  actionCell.appendChild(toggle);
  row.appendChild(actionCell);

  return row;
}

/**
 * @param {LogRecordLike[]} logs
 * @param {LogsViewState} state
 * @param {LogsViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderTable(logs, state, handlers) {
  const wrapper = element('div', 'logs-table-wrap');
  // Keyboard users must be able to scroll a wide table horizontally, so the
  // scroll container is focusable and exposes an accessible name.
  wrapper.tabIndex = 0;
  wrapper.setAttribute('data-focus-key', 'logs-table');
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Logs table, scrollable');
  const table = /** @type {HTMLTableElement} */ (document.createElement('table'));
  table.className = 'logs-table';

  const caption = element('caption', 'visually-hidden', 'Operation logs');
  table.appendChild(caption);

  const head = /** @type {HTMLTableSectionElement} */ (document.createElement('thead'));
  const headRow = /** @type {HTMLTableRowElement} */ (document.createElement('tr'));
  for (const [label, className] of [
    ['Time', 'logs-cell-time'],
    ['Source', 'logs-cell-source'],
    ['Agent', 'logs-cell-agent'],
    ['Operation', 'logs-cell-operation'],
    ['Level', 'logs-cell-level'],
    ['Duration', 'logs-cell-duration'],
    ['Summary', 'logs-cell-summary'],
    ['Details', 'logs-cell-actions'],
  ]) {
    const th = /** @type {HTMLTableCellElement} */ (document.createElement('th'));
    th.scope = 'col';
    th.className = className;
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = /** @type {HTMLTableSectionElement} */ (document.createElement('tbody'));
  for (const log of logs) {
    body.appendChild(renderLogRow(log, state, handlers));
    if (String(state.expandedId) === logKey(log) && logKey(log) !== '') {
      body.appendChild(renderDetailsRow(log));
    }
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

/**
 * @param {LogsFilters | undefined} filters
 * @param {LogsViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderEmpty(filters, handlers) {
  const empty = element('div', 'logs-empty');
  const filtered = hasActiveFilters(filters);
  empty.appendChild(
    element(
      'p',
      'logs-empty-message',
      filtered ? 'No logs match these filters.' : 'No logs recorded yet.'
    )
  );
  if (filtered) {
    const clear = createButton(
      'logs-empty-clear',
      'btn btn-sm btn-secondary logs-clear-filters',
      'Clear filters',
      'filter-x'
    );
    clear.addEventListener('click', () => handlers.onClearFilters?.());
    empty.appendChild(clear);
  }
  return empty;
}

/**
 * @param {LogsViewState} state
 * @param {LogsViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderError(state, handlers) {
  const block = element('div', 'logs-error');
  block.setAttribute('role', 'alert');
  block.appendChild(
    element('p', 'logs-error-message', state.error || 'The logs could not be loaded. Try again.')
  );
  const retry = createButton(
    'logs-retry',
    'btn btn-sm btn-secondary logs-retry',
    'Try again',
    'rotate-ccw'
  );
  retry.addEventListener('click', () => handlers.onRetry?.());
  block.appendChild(retry);
  return block;
}

/**
 * @returns {HTMLElement}
 */
function renderSkeleton() {
  const list = element('div', 'logs-skeleton-list');
  list.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < SKELETON_ROWS; index += 1) {
    const row = element('div', 'logs-skeleton');
    row.appendChild(element('div', 'skeleton logs-skeleton-line'));
    list.appendChild(row);
  }

  return list;
}

/**
 * @param {number} page
 * @param {number} pages
 * @param {LogsViewHandlers} handlers
 * @returns {HTMLElement}
 */
function renderPagination(page, pages, handlers) {
  const nav = element('nav', 'logs-pagination');
  nav.setAttribute('aria-label', 'Logs pagination');

  const prev = createButton(
    'logs-page-prev',
    'btn btn-sm btn-ghost logs-page-prev',
    'Previous',
    'chevron-left'
  );
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => handlers.onPageChange?.(page - 1));
  nav.appendChild(prev);

  const list = element('div', 'logs-page-list');
  for (const number of pageNumbers(page, pages)) {
    const button = createButton(
      `logs-page-${number}`,
      'btn btn-sm btn-ghost logs-page-button',
      String(number)
    );
    button.dataset.page = String(number);
    button.setAttribute('aria-label', `Page ${number}`);
    if (number === page) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => handlers.onPageChange?.(number));
    list.appendChild(button);
  }
  nav.appendChild(list);

  const next = createButton(
    'logs-page-next',
    'btn btn-sm btn-ghost logs-page-next',
    'Next',
    'chevron-right'
  );
  next.disabled = page >= pages;
  next.addEventListener('click', () => handlers.onPageChange?.(page + 1));
  nav.appendChild(next);

  return nav;
}

/**
 * Resolve the derived values shared by the full render and the body render.
 *
 * @param {LogsViewState} state
 */
function resolveFrame(state) {
  const status = state.status ?? 'idle';
  const allLogs = Array.isArray(state.logs) ? state.logs : [];
  const capped = capLogRows(allLogs, MAX_ROWS);
  const logs = capped.logs;
  // The app may cap the data slice before handing it over; pass its dropped
  // count through so the notice still explains the truncated table.
  const dropped =
    typeof state.dropped === 'number' && state.dropped >= capped.dropped
      ? state.dropped
      : capped.dropped;
  const total = Number.isFinite(state.total) ? Math.max(0, Number(state.total)) : logs.length;
  const range = paginationRange({ total, limit: state.limit, offset: state.offset });

  return { status, logs, dropped, total, range, isLoading: status === 'loading' };
}

/**
 * Build the replaceable result body: cap notice, table, pagination, or the
 * loading/empty/error state. It deliberately excludes the filter bar, the live
 * controls and the persistent `#logs-status` live region, so the composition
 * layer can replace this subtree without disturbing focus or a typed edit.
 *
 * @param {LogsViewState} [state]
 * @param {LogsViewHandlers} [handlers]
 * @returns {DocumentFragment}
 */
export function renderLogsBody(state = {}, handlers = {}) {
  const { status, logs, dropped, range, isLoading } = resolveFrame(state);
  const body = document.createDocumentFragment();

  if (status === 'error') {
    body.appendChild(renderError(state, handlers));
    return body;
  }

  if (isLoading && logs.length === 0) {
    body.appendChild(renderSkeleton());
    return body;
  }

  if (logs.length === 0) {
    body.appendChild(renderEmpty(state.filters, handlers));
    return body;
  }

  if (dropped > 0) {
    body.appendChild(
      element(
        'p',
        'logs-cap-notice',
        `Showing the newest ${MAX_ROWS} entries. ${dropped} older ${
          dropped === 1 ? 'entry is' : 'entries are'
        } hidden.`
      )
    );
  }

  body.appendChild(renderTable(logs, state, handlers));
  body.appendChild(renderPagination(range.page, range.pages, handlers));
  return body;
}

/**
 * Render the logs surface for `#logs-page`. The shell owns the single `h1`
 * (`#logs-heading`), so this view is a labelled region and never adds another.
 *
 * This whole-surface renderer is used by the pure view tests. At runtime
 * app.js mounts the same pieces through `createLogsPage`, which keeps the
 * filters, live controls and status node persistent.
 *
 * @param {LogsViewState} [state]
 * @param {LogsViewHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderLogsView(state = {}, handlers = {}) {
  const { isLoading } = resolveFrame(state);

  const section = element('section', 'logs-view');
  section.setAttribute('aria-labelledby', 'logs-heading');
  section.setAttribute('aria-busy', String(isLoading));

  section.appendChild(renderLogsFilters(state, handlers));
  section.appendChild(renderLogsLiveBar(state, handlers));

  const region = element('div', 'logs-region');
  region.id = 'logs-region';

  const statusNode = element('p', 'logs-status', logsStatusText(state));
  statusNode.id = 'logs-status';
  statusNode.setAttribute('role', 'status');
  statusNode.setAttribute('aria-live', 'polite');
  statusNode.setAttribute('aria-busy', String(isLoading));
  region.appendChild(statusNode);

  // Mirror the runtime `createLogsPage` structure so the flex scroll contract
  // applies to this renderer too: the body owns the remaining height and the
  // table wrapper scrolls internally.
  const body = element('div', 'logs-body');
  body.appendChild(renderLogsBody(state, handlers));
  region.appendChild(body);
  section.appendChild(region);
  return section;
}
