// @ts-check

import { buildQuery, requestWithResponse } from './http.js';

/** @typedef {'high' | 'medium' | 'low'} SearchConfidence */
/**
 * @typedef {{
 *   q?: string,
 *   space?: string,
 *   tag?: string,
 *   tier?: 1 | 2 | 3,
 *   tiers?: string,
 *   confidence?: SearchConfidence,
 *   semantic?: boolean | 'on' | 'off',
 *   limit?: number,
 *   offset?: number,
 * }} SearchOptions
 */
/** @typedef {{ results: unknown[], total: number, hasMore: boolean }} SearchResponse */
/** @typedef {{ signal?: AbortSignal }} RequestOptions */

/**
 * Search memories through the unified pipeline.
 *
 * `semantic` is opt-in. The web always sends an explicit `on`/`off` so the
 * server does not fall back to its RAG default; omit the option to keep the
 * server default (MCP behavior).
 *
 * @param {SearchOptions} [options]
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<SearchResponse>}
 */
export async function searchMemories(options = {}, requestOptions = {}) {
  const { q, space, tag, tier, tiers, confidence, semantic, limit, offset } = options;

  /** @type {'on' | 'off' | undefined} */
  let semanticParam;
  if (semantic === true || semantic === 'on') {
    semanticParam = 'on';
  } else if (semantic === false || semantic === 'off') {
    semanticParam = 'off';
  }

  const path = `/api/search${buildQuery({
    q,
    space: space && space !== '*' ? space : undefined,
    tag,
    tier,
    tiers,
    confidence,
    semantic: semanticParam,
    limit,
    offset,
  })}`;

  const { data, response } = await requestWithResponse(path, requestOptions);
  const results = Array.isArray(data) ? data : [];

  const totalHeader = response.headers.get('X-Total-Count');
  const hasMoreHeader = response.headers.get('X-Has-More');
  const parsedTotal = totalHeader === null ? Number.NaN : Number(totalHeader);

  return {
    results,
    total: Number.isFinite(parsedTotal) ? parsedTotal : results.length,
    hasMore: hasMoreHeader === null ? false : hasMoreHeader === 'true',
  };
}
