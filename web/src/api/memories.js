// @ts-check

import { buildQuery, request, requestWithResponse } from './http.js';

/** @typedef {1 | 2 | 3} Tier */
/** @typedef {{ tier?: Tier, tag?: string }} ListMemoriesOptions */
/** @typedef {{ space?: string, tag?: string, tier?: Tier, tiers?: string, from?: string, to?: string, limit?: number, offset?: number }} QueryMemoriesOptions */
/** @typedef {{ name: string, content: string, tags?: string[], tier?: Tier }} CreateMemoryInput */
/** @typedef {{ content?: string, pinned?: boolean, addTag?: string, removeTag?: string, promote?: boolean, demote?: boolean }} UpdateMemoryInput */
/** @typedef {{ signal?: AbortSignal }} RequestOptions */

/**
 * @param {string} spaceName
 * @param {ListMemoriesOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function listMemories(spaceName, options = {}, requestOptions) {
  const { tier, tag } = options;
  return request(
    `/api/spaces/${encodeURIComponent(spaceName)}/memories${buildQuery({ tier, tag })}`,
    requestOptions
  );
}

/**
 * Paginated metadata/date query across spaces.
 *
 * @param {QueryMemoriesOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function queryMemories(options = {}, requestOptions) {
  const { space, tag, tier, tiers, from, to, limit, offset } = options;
  return request(
    `/api/memories/query${buildQuery({ space, tag, tier, tiers, from, to, limit, offset })}`,
    requestOptions
  );
}

/**
 * One page of the metadata/date query plus the total from `X-Total-Count`.
 *
 * The endpoint returns a flat array and an additive header, matching
 * `/api/search`. When the header is missing (or not a number) the page size is
 * used as the total so the list still renders a truthful "showing" count.
 *
 * @param {QueryMemoriesOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<{ items: unknown[], total: number }>}
 */
export async function queryMemoryPage(options = {}, requestOptions) {
  const { space, tag, tier, tiers, from, to, limit, offset } = options;
  const { data, response } = await requestWithResponse(
    `/api/memories/query${buildQuery({ space, tag, tier, tiers, from, to, limit, offset })}`,
    requestOptions
  );

  const items = Array.isArray(data) ? data : [];
  const totalHeader = response.headers.get('X-Total-Count');
  const parsedTotal = totalHeader === null ? Number.NaN : Number(totalHeader);

  return {
    items,
    total: Number.isFinite(parsedTotal) ? parsedTotal : items.length,
  };
}

/**
 * @param {string} spaceName
 * @param {string} memoryName
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function getMemory(spaceName, memoryName, requestOptions) {
  return request(
    `/api/spaces/${encodeURIComponent(spaceName)}/memories/${encodeURIComponent(memoryName)}`,
    requestOptions
  );
}

/**
 * @param {string} spaceName
 * @param {CreateMemoryInput} input
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function createMemory(spaceName, input, requestOptions) {
  return request(`/api/spaces/${encodeURIComponent(spaceName)}/memories`, {
    ...requestOptions,
    method: 'POST',
    body: input,
  });
}

/**
 * @param {string} spaceName
 * @param {string} memoryName
 * @param {UpdateMemoryInput} changes
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function updateMemory(spaceName, memoryName, changes, requestOptions) {
  return request(
    `/api/spaces/${encodeURIComponent(spaceName)}/memories/${encodeURIComponent(memoryName)}`,
    { ...requestOptions, method: 'PATCH', body: changes }
  );
}

/**
 * @param {string} spaceName
 * @param {string} memoryName
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<unknown>}
 */
export function deleteMemory(spaceName, memoryName, requestOptions) {
  return request(
    `/api/spaces/${encodeURIComponent(spaceName)}/memories/${encodeURIComponent(memoryName)}`,
    { ...requestOptions, method: 'DELETE' }
  );
}
