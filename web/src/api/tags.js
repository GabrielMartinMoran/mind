// @ts-check

import { request } from './http.js';

/** @typedef {{ signal?: AbortSignal }} TagRequestOptions */

/**
 * List the distinct memory tags of one space, used to populate the shared Tag
 * select. The endpoint returns a sorted `string[]`; an unknown or empty space
 * returns `[]`.
 *
 * @param {string} spaceName
 * @param {TagRequestOptions} [requestOptions]
 * @returns {Promise<string[]>}
 */
export function listSpaceMemoryTags(spaceName, requestOptions) {
  return request(`/api/spaces/${encodeURIComponent(spaceName)}/tags`, requestOptions);
}
