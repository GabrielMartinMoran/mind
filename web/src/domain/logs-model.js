// @ts-check
/**
 * Pure logs domain helpers.
 *
 * Everything here is deterministic and side-effect free: request-filter
 * building, response normalization, pagination math, the live poll policy and
 * the row cap that keeps the logs DOM bounded. No DOM, no fetch, no state.
 */

/** @typedef {'cli' | 'mcp' | 'api'} LogSource */
/** @typedef {'info' | 'warn' | 'error'} LogLevel */

/**
 * @typedef {Object} LogRecordLike
 * @property {number | string} [id]
 * @property {string} [source]
 * @property {string} [operation]
 * @property {string} [level]
 * @property {string | null} [input_data]
 * @property {string | null} [output_data]
 * @property {string | null} [error_message]
 * @property {string | null} [caller_info]
 * @property {number | null} [duration_ms]
 * @property {string} [timestamp]
 */

/**
 * @typedef {Object} LogsFilters
 * @property {string | null} [source]
 * @property {string | null} [operation]
 * @property {string | null} [level]
 * @property {string | null} [search]
 * @property {string | null} [from]
 * @property {string | null} [to]
 * @property {number} [limit]
 * @property {number} [offset]
 */

/**
 * @typedef {Object} NormalizedLogs
 * @property {LogRecordLike[]} logs
 * @property {number} total
 * @property {number} limit
 * @property {number} offset
 */

/**
 * @typedef {Object} PaginationRange
 * @property {number} from
 * @property {number} to
 * @property {number} page
 * @property {number} pages
 * @property {boolean} hasPrev
 * @property {boolean} hasNext
 */

export const DEFAULT_LIMIT = 25;
export const MAX_ROWS = 500;
export const LOG_SOURCES = /** @type {const} */ (['cli', 'mcp', 'api']);
export const LOG_LEVELS = /** @type {const} */ (['info', 'warn', 'error']);

/**
 * Compact labels for the canonical agent names written by `MIND_AGENT` or the
 * MCP initialize `clientInfo`. Anything else keeps its raw canonical value.
 */
export const AGENT_LABELS = /** @type {const} */ ({
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  'gemini-cli': 'Gemini CLI',
  vscode: 'VS Code',
  antigravity: 'Antigravity',
  pi: 'Pi',
});

/**
 * @typedef {Object} LogAgent
 * @property {string | null} agent Canonical agent name, or null when absent.
 * @property {string} label Compact label for the table.
 * @property {string} raw Raw canonical value for the title/accessible name.
 */

/**
 * Parse `caller_info` without ever throwing. The API stores it as a JSON string
 * but older rows or in-memory fixtures may hand over an object already.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function parseCallerInfo(value) {
  if (value === null || value === undefined || value === '') return null;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Resolve the display contract for the Agent column.
 *
 * @param {unknown} callerInfo
 * @returns {LogAgent}
 */
export function describeLogAgent(callerInfo) {
  const info = parseCallerInfo(callerInfo);
  const raw =
    info && typeof info.agent === 'string' ? /** @type {string} */ (info.agent).trim() : '';

  if (!raw || raw === 'unknown') return { agent: null, label: '', raw: '' };

  return {
    agent: raw,
    label: /** @type {Record<string, string>} */ (AGENT_LABELS)[raw] ?? raw,
    raw,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function countOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeIntOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize a `GET /api/logs` response into a stable shape.
 *
 * @param {unknown} [response]
 * @returns {NormalizedLogs}
 */
export function normalizeLogs(response) {
  const source = response && typeof response === 'object' ? /** @type {any} */ (response) : {};
  const logs = Array.isArray(source.logs) ? /** @type {LogRecordLike[]} */ (source.logs) : [];

  return {
    logs,
    total: countOr(source.total, logs.length),
    limit: Math.min(MAX_ROWS, positiveIntOr(source.limit, DEFAULT_LIMIT)),
    offset: nonNegativeIntOr(source.offset, 0),
  };
}

/**
 * Build the request params for the logs API. Empty and unknown values are
 * omitted; `limit` is clamped to `[1, MAX_ROWS]` and `offset` is never negative.
 *
 * @param {LogsFilters} [filters]
 * @returns {Record<string, string | number>}
 */
export function filterParams(filters = {}) {
  /** @type {Record<string, string | number>} */
  const params = {};

  // Only the documented sources are forwarded; "all", unknown values and the
  // legacy multi-checkbox string are dropped instead of reaching the API.
  const source = trimmed(filters.source).toLowerCase();
  if (LOG_SOURCES.includes(/** @type {LogSource} */ (source))) params.source = source;

  const operation = trimmed(filters.operation);
  if (operation) params.operation = operation;

  const level = trimmed(filters.level);
  if (LOG_LEVELS.includes(/** @type {LogLevel} */ (level))) params.level = level;

  const search = trimmed(filters.search);
  if (search) params.search = search;

  const from = trimmed(filters.from);
  if (from) params.from = from;

  const to = trimmed(filters.to);
  if (to) params.to = to;

  params.limit = Math.min(MAX_ROWS, positiveIntOr(filters.limit, DEFAULT_LIMIT));
  params.offset = nonNegativeIntOr(filters.offset, 0);

  return params;
}

/**
 * Compute the inclusive range, page and navigation flags for a page.
 * An empty collection reports page 1 with zero pages so controls stay stable.
 *
 * @param {{ total?: number, limit?: number, offset?: number }} [options]
 * @returns {PaginationRange}
 */
export function paginationRange(options = {}) {
  const total = countOr(options.total, 0);
  const limit = Math.min(MAX_ROWS, positiveIntOr(options.limit, DEFAULT_LIMIT));
  const offset = nonNegativeIntOr(options.offset, 0);
  const pages = total === 0 ? 0 : Math.ceil(total / limit);

  if (total === 0) {
    return { from: 0, to: 0, page: 1, pages: 0, hasPrev: false, hasNext: false };
  }

  const page = Math.min(Math.floor(offset / limit) + 1, pages);
  return {
    from: Math.min(offset + 1, total),
    to: Math.min(offset + limit, total),
    page,
    pages,
    hasPrev: page > 1,
    hasNext: page < pages,
  };
}

/**
 * Keep the newest rows and drop the oldest ones. Logs are expected newest-first
 * (the API's default `order=desc`), so the leading `max` entries are kept and
 * the tail is discarded. This is what bounds the live-mode DOM.
 *
 * @param {readonly LogRecordLike[] | null | undefined} logs
 * @param {number} [max]
 * @returns {{ logs: LogRecordLike[], dropped: number }}
 */
export function capLogRows(logs, max = MAX_ROWS) {
  const list = Array.isArray(logs) ? logs : [];
  const cap = Math.min(MAX_ROWS, positiveIntOr(max, MAX_ROWS));
  if (list.length <= cap) return { logs: list, dropped: 0 };
  return { logs: list.slice(0, cap), dropped: list.length - cap };
}

/**
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * Parse a backend timestamp (UTC, `YYYY-MM-DD HH:mm:ss`) or an ISO timestamp
 * into a Date. Returns `null` for missing or invalid input.
 *
 * @param {string | null | undefined} value
 * @returns {Date | null}
 */
function parseLogDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const raw = value.trim();
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Format a backend timestamp (UTC) as the same stable, human-readable UTC
 * string. Accepts an ISO timestamp as well and returns `''` for invalid input.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function formatLogTime(value) {
  const date = parseLogDate(value);
  if (!date) return '';

  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    ` ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`
  );
}

/**
 * Canonicalize a backend timestamp into an ISO `datetime` value with a `T`
 * separator and a `Z` UTC suffix. Returns `''` for missing or invalid input so
 * the caller can omit the attribute.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function toIsoDateTime(value) {
  const date = parseLogDate(value);
  if (!date) return '';

  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`
  );
}

/**
 * Format a duration in milliseconds. Missing or invalid values render as an
 * em dash so table cells stay aligned.
 *
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return `${Math.max(0, Math.round(ms))}ms`;
}

/**
 * Live polling policy: poll only when live mode is on, the tab is visible and no
 * request is already in flight or failed (a failure needs an explicit retry).
 *
 * @param {{ live?: boolean, visible?: boolean, status?: string }} [state]
 * @returns {boolean}
 */
export function shouldPoll(state = {}) {
  if (state.live !== true) return false;
  if (state.visible === false) return false;
  if (state.status === 'loading' || state.status === 'error') return false;
  return true;
}
