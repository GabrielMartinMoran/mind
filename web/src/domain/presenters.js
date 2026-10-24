// @ts-check

/**
 * Pure DTO → view-model presenters. They preserve the property names the app
 * already renders, strip backend-internal fields, and add display labels only.
 * No DOM, no fetch, no global state.
 */

import { tierLabel } from './memory-model.js';
import { formatConfidence, formatMethods } from './search-model.js';

const INTERNAL_FIELDS = ['embedding', 'fts_id', 'space_id'];

/**
 * Copy a record without backend-internal fields.
 *
 * @param {Record<string, any>} dto
 * @returns {Record<string, any>}
 */
function stripInternalFields(dto) {
  /** @type {Record<string, any>} */
  const copy = {};
  for (const [key, value] of Object.entries(dto ?? {})) {
    if (!INTERNAL_FIELDS.includes(key)) copy[key] = value;
  }
  return copy;
}

/**
 * Format an ISO timestamp as a stable date label (UTC, day precision).
 *
 * @param {unknown} value
 * @returns {string}
 */
function changedLabel(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * @param {Record<string, any>} space
 * @returns {Record<string, any>}
 */
export function presentSpace(space) {
  return stripInternalFields(space);
}

/**
 * @param {Record<string, any>} memory
 * @returns {Record<string, any>}
 */
export function presentMemorySummary(memory) {
  const presented = stripInternalFields(memory);
  return { ...presented, tierLabel: tierLabel(presented.tier) };
}

/**
 * @param {Record<string, any>} memory
 * @returns {Record<string, any>}
 */
export function presentMemoryDetail(memory) {
  const presented = stripInternalFields(memory);
  return {
    ...presented,
    tierLabel: tierLabel(presented.tier),
    changedLabel: changedLabel(presented.changed_at),
  };
}

/**
 * @param {Record<string, any>} result
 * @returns {Record<string, any>}
 */
export function presentSearchResult(result) {
  const presented = stripInternalFields(result);
  return {
    ...presented,
    tierLabel: tierLabel(presented.tier),
    confidenceLabel: formatConfidence(presented.confidence),
    methodsLabel: formatMethods(presented.methods).join(', '),
    changedLabel: changedLabel(presented.changed_at),
  };
}
