// @ts-check

import { buildQuery, request } from './http.js';

/**
 * @typedef {{
 *   source?: string,
 *   operation?: string,
 *   search?: string,
 *   from?: string,
 *   to?: string,
 *   level?: string,
 *   limit?: number,
 *   offset?: number,
 *   order?: string,
 *   since?: number,
 * }} LogFilter
 */
/** @typedef {{ signal?: AbortSignal }} RequestOptions */

/**
 * @param {LogFilter} [filter]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function listLogs(filter = {}, requestOptions) {
  const { source, operation, search, from, to, level, limit, offset, order, since } = filter;
  return request(
    `/api/logs${buildQuery({
      source,
      operation,
      search,
      from,
      to,
      level,
      limit,
      offset,
      order,
      since,
    })}`,
    requestOptions
  );
}

/**
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function clearLogs(requestOptions) {
  return request('/api/logs', { ...requestOptions, method: 'DELETE' });
}
