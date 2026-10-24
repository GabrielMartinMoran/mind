// @ts-check

import { normalizeTiers, tierParams } from '../../domain/filter-model.js';

/** @typedef {'list'|'map'} SpaceView */
/** @typedef {1|2|3} Tier */
/** @typedef {'high'|'medium'|'low'} Confidence */
/**
 * @typedef {{
 *   spaceName: string|null,
 *   view: SpaceView,
 *   memoryName: string|null,
 *   isLogsPage?: boolean,
 *   q: string,
 *   spaceFilter: string|null,
 *   tag: string,
 *   tiers: Tier[],
 *   tier: Tier|null,
 *   confidence: Confidence|null,
 *   semantic: boolean,
 * }} AppRoute
 */
/**
 * @typedef {{
 *   spaceName?: string|null,
 *   view?: string|null,
 *   memoryName?: string|null,
 *   isLogsPage?: boolean,
 *   q?: string|null,
 *   spaceFilter?: string|null,
 *   tag?: string|null,
 *   tiers?: number[]|null,
 *   tier?: number|null,
 *   confidence?: string|null,
 *   semantic?: boolean,
 * }} BuildAppRouteInput
 */

/** @param {string|null} view @returns {SpaceView} */
function normalizeView(view) {
  return view === 'map' ? 'map' : 'list';
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** @param {string|null} value @returns {Tier|null} */
function parseTier(value) {
  if (value === '1') return 1;
  if (value === '2') return 2;
  if (value === '3') return 3;
  return null;
}

/** @param {string|null} value @returns {Confidence|null} */
function parseConfidence(value) {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return null;
}

/**
 * Resolve the inclusive tier selection. `tiers` wins when it contains at least
 * one valid value; otherwise fall back to the legacy single `tier`. The full
 * set collapses to `[]`, which means "all tiers".
 *
 * @param {URLSearchParams} params
 * @returns {Tier[]}
 */
function parseTiers(params) {
  const fromList = normalizeTiers(params.get('tiers'));
  if (fromList.length > 0) {
    return fromList.length === 3 ? [] : fromList;
  }
  const single = parseTier(params.get('tier'));
  return single === null ? [] : [single];
}

/**
 * Parse only the supported filter params. Unknown or invalid values are dropped.
 *
 * @param {URLSearchParams} params
 * @returns {{ q: string, tag: string, tiers: Tier[], tier: Tier|null, confidence: Confidence|null, semantic: boolean }}
 */
function parseFilters(params) {
  const tiers = parseTiers(params);
  return {
    q: params.get('q') ?? '',
    tag: params.get('tag') ?? '',
    tiers,
    // Compatibility view of the selection for callers that only understand one tier.
    tier: tiers.length === 1 ? tiers[0] : null,
    confidence: parseConfidence(params.get('confidence')),
    semantic: params.get('semantic') === 'on',
  };
}

/** @param {string} pathname @param {string} search @returns {AppRoute} */
function parseAppRoute(pathname, search) {
  if (pathname === '/') {
    return {
      spaceName: null,
      view: 'list',
      memoryName: null,
      q: '',
      spaceFilter: null,
      tag: '',
      tiers: [],
      tier: null,
      confidence: null,
      semantic: false,
    };
  }

  if (pathname === '/logs') {
    return {
      spaceName: null,
      view: 'list',
      memoryName: null,
      isLogsPage: true,
      q: '',
      spaceFilter: null,
      tag: '',
      tiers: [],
      tier: null,
      confidence: null,
      semantic: false,
    };
  }

  const params = new URLSearchParams(search ?? '');

  const match = /^\/spaces\/([^/]+)$/.exec(pathname);
  if (!match) {
    return {
      spaceName: null,
      view: 'list',
      memoryName: null,
      q: '',
      spaceFilter: null,
      tag: '',
      tiers: [],
      tier: null,
      confidence: null,
      semantic: false,
    };
  }

  const decodedSpace = safeDecode(match[1] ?? '');
  if (!decodedSpace) {
    return {
      spaceName: null,
      view: 'list',
      memoryName: null,
      q: '',
      spaceFilter: null,
      tag: '',
      tiers: [],
      tier: null,
      confidence: null,
      semantic: false,
    };
  }

  return {
    spaceName: decodedSpace,
    view: normalizeView(params.get('view')),
    memoryName: params.get('memory'),
    ...parseFilters(params),
    spaceFilter: null,
  };
}

/**
 * Serialize non-default filters in a stable order.
 *
 * @param {BuildAppRouteInput} route
 * @returns {string[]}
 */
function filterParts(route) {
  /** @type {string[]} */
  const parts = [];
  if (route.q) parts.push(`q=${encodeURIComponent(route.q)}`);
  if (route.tag) parts.push(`tag=${encodeURIComponent(route.tag)}`);
  const tiers = Array.isArray(route.tiers) ? route.tiers : route.tier != null ? [route.tier] : [];
  const { tier, tiers: tierList } = tierParams(tiers);
  if (tier) parts.push(`tier=${tier}`);
  if (tierList) parts.push(`tiers=${tierList}`);
  if (route.confidence === 'high' || route.confidence === 'medium' || route.confidence === 'low') {
    parts.push(`confidence=${route.confidence}`);
  }
  if (route.semantic === true) parts.push('semantic=on');
  return parts;
}

/** @param {BuildAppRouteInput} route */
function buildAppUrl(route) {
  if (route?.isLogsPage) {
    return '/logs';
  }

  if (!route?.spaceName) {
    return '/';
  }

  const encodedSpace = encodeURIComponent(route.spaceName);
  /** @type {string[]} */
  const parts = [];
  if (normalizeView(route.view ?? null) === 'map') parts.push('view=map');
  if (route.memoryName) parts.push(`memory=${encodeURIComponent(route.memoryName)}`);
  parts.push(...filterParts(route));

  return parts.length > 0
    ? `/spaces/${encodedSpace}?${parts.join('&')}`
    : `/spaces/${encodedSpace}`;
}

export { parseAppRoute, buildAppUrl };
