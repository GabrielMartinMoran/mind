import { normalizeTag } from '../../helpers/tags';
import type { Tier } from '../../types';

import type { RouteDefinition } from './types';
import { exact } from './types';

function parseTier(raw: string | null): Tier | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (n >= 1 && n <= 3) return n as Tier;
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

export const searchRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    match: exact('/api/search'),
    handle: async ({ url, store, json }) => {
      const q = url.searchParams.get('q') ?? '';
      if (!q) return json([]);

      // Unified pipeline (D1/D6): default page 25, optional limit/offset.
      // `space=*` means all spaces; the response stays a flat array (additive
      // score/confidence/methods fields keep the web client working).
      const spaceRaw = url.searchParams.get('space');
      const space = !spaceRaw || spaceRaw === '*' ? undefined : spaceRaw;
      const tagRaw = url.searchParams.get('tag');
      const tag = tagRaw ? normalizeTag(tagRaw) : undefined;
      const tier = parseTier(url.searchParams.get('tier'));
      const limit = parsePositiveInt(url.searchParams.get('limit'), 25);
      const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0);

      return json(await store.search(q, { space, tag, tier, limit, offset }));
    },
  },
];
