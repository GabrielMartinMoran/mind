// @ts-check

import { buildQuery, request } from './http.js';

/** @typedef {{ tag?: string, includeHidden?: boolean }} ListSpacesOptions */
/** @typedef {{ name: string, description?: string, tags?: string[] }} CreateSpaceInput */
/** @typedef {{ description?: string, newName?: string, addTag?: string, removeTag?: string }} UpdateSpaceInput */
/** @typedef {{ signal?: AbortSignal }} RequestOptions */

/**
 * List spaces, optionally including hidden spaces and filtering by tag.
 *
 * @param {ListSpacesOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function listSpaces(options = {}, requestOptions) {
  const { tag, includeHidden } = options;
  return request(
    `/api/spaces${buildQuery({
      tag,
      includeHidden: includeHidden ? 'true' : undefined,
    })}`,
    requestOptions
  );
}

/**
 * @param {string} spaceName
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function getSpace(spaceName, requestOptions) {
  return request(`/api/spaces/${encodeURIComponent(spaceName)}`, requestOptions);
}

/**
 * @param {CreateSpaceInput} input
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function createSpace(input, requestOptions) {
  return request('/api/spaces', { ...requestOptions, method: 'POST', body: input });
}

/**
 * @param {string} spaceName
 * @param {UpdateSpaceInput} changes
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function updateSpace(spaceName, changes, requestOptions) {
  return request(`/api/spaces/${encodeURIComponent(spaceName)}`, {
    ...requestOptions,
    method: 'PATCH',
    body: changes,
  });
}

/**
 * @param {string} spaceName
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function deleteSpace(spaceName, requestOptions) {
  return request(`/api/spaces/${encodeURIComponent(spaceName)}`, {
    ...requestOptions,
    method: 'DELETE',
  });
}
