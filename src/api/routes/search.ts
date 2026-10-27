import { normalizeTag } from '../../helpers/tags';
import type { SearchConfidence } from '../../store/shared/search-fusion';
import { EmptySearchQueryError } from '../../store/shared/search-query-error';

import { resolveTierFilter } from './query-filters';
import type { RouteDefinition } from './types';
import { exact } from './types';

/** Known confidence buckets; anything else is ignored like an invalid tier. */
const CONFIDENCE_VALUES: ReadonlySet<SearchConfidence> = new Set(['high', 'medium', 'low']);

function parseConfidence(raw: string | null): SearchConfidence | undefined {
  if (!raw) return undefined;
  return CONFIDENCE_VALUES.has(raw as SearchConfidence) ? (raw as SearchConfidence) : undefined;
}

/**
 * `semantic=on|off`. Omitted/invalid values keep the server default (the
 * semantic channel runs when RAG is enabled), matching MCP behavior.
 */
function parseSemantic(raw: string | null): boolean | undefined {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return undefined;
}

/** Parse a positive integer query param, falling back when absent/invalid. */
function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a non-negative integer query param, falling back when absent/invalid. */
function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Flat `ScoredSearchResult[]` body plus additive pagination headers. `total`
 * is the admitted count after filters (confidence included) and before
 * pagination; `X-Has-More` compares the next offset against it.
 */
function searchResponse(results: unknown[], total: number, offset: number): Response {
  return Response.json(results, {
    headers: {
      'X-Total-Count': String(total),
      'X-Has-More': offset + results.length < total ? 'true' : 'false',
    },
  });
}

export const searchRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    match: exact('/api/search'),
    handle: async ({ url, store }) => {
      // Absent q is "no text search" (200 + empty totals); an explicitly
      // supplied q always enters the search pipeline, even when blank.
      if (!url.searchParams.has('q')) return searchResponse([], 0, 0);
      const q = url.searchParams.get('q') ?? '';

      // Unified pipeline (D1/D6): default page 25, optional limit/offset.
      // `space=*` means all spaces; the response stays a flat array (additive
      // score/confidence/methods fields keep the web client working).
      const spaceRaw = url.searchParams.get('space');
      const space = !spaceRaw || spaceRaw === '*' ? undefined : spaceRaw;
      const tagRaw = url.searchParams.get('tag');
      const tag = tagRaw ? normalizeTag(tagRaw) : undefined;
      const tierFilter = resolveTierFilter(url.searchParams);
      const confidence = parseConfidence(url.searchParams.get('confidence'));
      const semantic = parseSemantic(url.searchParams.get('semantic'));
      const limit = parsePositiveInt(url.searchParams.get('limit'), 25);
      const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0);

      try {
        const { results, total } = await store.searchPage(q, {
          space,
          tag,
          ...tierFilter,
          confidence,
          semantic,
          limit,
          offset,
        });
        return searchResponse(results, total, offset);
      } catch (error) {
        if (error instanceof EmptySearchQueryError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    },
  },
];
