import type { MindStore } from '../../../store/mind-store';
import { toCompatSearchMethod } from '../../../store/shared';
import type { Tier } from '../../../types';
import { filterByDateRange } from '../../helpers/date-filter';
import { presentMemoryResponse } from '../../helpers/memory-response';
import { buildYamlContent } from '../../helpers/yaml-response';
import { MemoryQuerySchema } from '../../schemas/memories/query-memories';

interface MemoryQueryPayload {
  memories: any[];
  total: number;
  limit: number;
  offset: number;
  search_method?: string;
}

export function applyDateFilters<T extends { changed_at: string }>(
  results: T[],
  from?: string,
  to?: string
): T[] {
  return filterByDateRange(results, from, to);
}

function buildMemoryQueryResponse(
  memories: any[],
  totalCount: number,
  search_method: string | undefined,
  parsed: { limit?: number; offset?: number }
): ReturnType<typeof buildYamlContent<MemoryQueryPayload>> {
  const response: MemoryQueryPayload = {
    memories: memories.map(
      ({
        id: _id,
        content: _c,
        rank: _r,
        similarity: _s,
        created_at: _created_at,
        updated_at: _updated_at,
        ...rest
      }: any) => presentMemoryResponse(rest)
    ),
    total: totalCount,
    limit: parsed.limit ?? 25,
    offset: parsed.offset ?? 0,
  };

  if (search_method) {
    response.search_method = search_method;
  }

  return buildYamlContent(response);
}

export function queryMemoriesHandler(store: MindStore) {
  return async (args: unknown) => {
    let parsed;
    try {
      parsed = MemoryQuerySchema.parse(args ?? {});
    } catch (e: any) {
      if (e.issues?.length) {
        const spaceError = e.issues.find((err: any) => err.path?.includes('space'));
        if (spaceError) {
          throw new Error('space is required');
        }
      }
      throw e;
    }

    const spaceFilter = parsed.space === '*' ? undefined : parsed.space;
    const tierFilter = parsed.tier ?? undefined;

    let memories: any[];
    let totalCount: number;
    let search_method: string | undefined;

    if (parsed.search !== undefined) {
      // Unified pipeline (D1): fused ranking with confidence/methods provenance.
      const results = await store.search(parsed.search, {
        space: spaceFilter,
        tag: parsed.tag,
        tier: tierFilter as Tier | undefined,
      });

      const filteredResults = applyDateFilters(results, parsed.from, parsed.to);

      totalCount = filteredResults.length;
      // Compatibility field: primary channel of the top-ranked result (D5).
      search_method = filteredResults[0]
        ? toCompatSearchMethod(filteredResults[0].methods)
        : undefined;

      const offset = parsed.offset ?? 0;
      const limit = parsed.limit ?? 25;
      memories = filteredResults.slice(offset, offset + limit);
    } else {
      memories = store.queryMemories({
        space: spaceFilter,
        tag: parsed.tag,
        tier: tierFilter as Tier | undefined,
        from: parsed.from,
        to: parsed.to,
        limit: parsed.limit ?? 25,
        offset: parsed.offset ?? 0,
      });

      totalCount = await store.queryMemoriesCount({
        space: spaceFilter,
        tag: parsed.tag,
        tier: tierFilter as Tier | undefined,
        from: parsed.from,
        to: parsed.to,
      });
    }

    return buildMemoryQueryResponse(memories, totalCount, search_method, parsed);
  };
}
