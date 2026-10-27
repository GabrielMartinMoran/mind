// @ts-check

import { buildQuery, request } from './http.js';

/** @typedef {{ limit?: number }} GraphOptions */
/** @typedef {{ signal?: AbortSignal }} RequestOptions */

/**
 * @param {string} spaceName
 * @param {GraphOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function getSpaceGraph(spaceName, options = {}, requestOptions) {
  return request(
    `/api/spaces/${encodeURIComponent(spaceName)}/graph${buildQuery({ limit: options.limit })}`,
    requestOptions
  );
}
