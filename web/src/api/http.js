// @ts-check

/** @typedef {{ signal?: AbortSignal }} ApiRequestOptions */

/**
 * Error thrown for non-2xx API responses. Carries the HTTP status and the
 * parsed (or raw text) response body so callers can branch without re-reading
 * the response.
 */
export class ApiError extends Error {
  /** @type {number} */
  status;
  /** @type {unknown} */
  body;

  /**
   * @param {string} message
   * @param {number} status
   * @param {unknown} body
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Parse a response body as JSON, falling back to raw text for non-JSON bodies.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Extract a useful error message from a parsed body.
 *
 * @param {unknown} body
 * @param {string} fallback
 * @returns {string}
 */
function errorMessage(body, fallback) {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = /** @type {{ error?: unknown }} */ (body).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  return fallback;
}

/**
 * Perform a fetch and return both the parsed payload and the raw Response so
 * callers that need headers (for example search totals) can read them.
 *
 * @param {string} path
 * @param {{
 *   method?: string,
 *   body?: unknown,
 *   signal?: AbortSignal,
 *   headers?: Record<string, string>,
 * }} [options]
 * @returns {Promise<{ data: unknown, response: Response }>}
 */
export async function requestWithResponse(path, { method = 'GET', body, signal, headers } = {}) {
  /** @type {Record<string, string>} */
  const requestHeaders = { ...(headers ?? {}) };

  /** @type {RequestInit} */
  const init = { method, signal, headers: requestHeaders };

  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  const data = parseBody(text);

  if (!response.ok) {
    const fallback = response.statusText || `Request failed with status ${response.status}`;
    throw new ApiError(errorMessage(data, fallback), response.status, data);
  }

  return { data, response };
}

/**
 * Small JSON request wrapper. No retries and no implicit timeout; cancellation
 * is delegated to the caller's AbortSignal.
 *
 * @template T
 * @param {string} path
 * @param {{
 *   method?: string,
 *   body?: unknown,
 *   signal?: AbortSignal,
 *   headers?: Record<string, string>,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function request(path, options) {
  const { data } = await requestWithResponse(path, options);
  return /** @type {T} */ (data);
}

/**
 * Build a query string, omitting undefined, null and empty-string values.
 * Returns an empty string when nothing remains.
 *
 * @param {Record<string, string | number | boolean | null | undefined>} params
 * @returns {string}
 */
export function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}
