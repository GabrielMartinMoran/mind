import type { MindStore } from '../../store/mind-store';
import type { MemorySummary, Tier } from '../../types';

import { presentHotMemoryResponse } from './memory-response';

export type TrendingCoverage = 'complete' | 'subset';

export interface TrendingTierBlock {
  total_count: number;
  returned_count: number;
  coverage: TrendingCoverage;
  memories: ReturnType<typeof presentHotMemoryResponse>[];
}

export interface ReferencesBlock {
  total: number;
  returned_count: number;
  coverage: TrendingCoverage;
  memories: ReturnType<typeof presentHotMemoryResponse>[];
}

export function determineTrendingCoverage(
  returnedCount: number,
  totalCount: number
): TrendingCoverage {
  if (returnedCount === totalCount || (returnedCount === 0 && totalCount === 0)) {
    return 'complete';
  }

  return 'subset';
}

function presentHotMemories(
  memories: MemorySummary[]
): ReturnType<typeof presentHotMemoryResponse>[] {
  return memories.map(memory => presentHotMemoryResponse(memory));
}

export function buildTrendingTierBlock(
  store: MindStore,
  space: string,
  tier: Tier,
  previewLimit: number
): TrendingTierBlock {
  const { total_count: totalCount, memories: summaries } = store.getTrendingMemories(
    space,
    tier,
    previewLimit
  );
  const memories = presentHotMemories(summaries);

  return {
    total_count: totalCount,
    returned_count: memories.length,
    coverage: determineTrendingCoverage(memories.length, totalCount),
    memories,
  };
}

export function buildReferencesBlock(
  store: MindStore,
  space: string,
  limit: number
): ReferencesBlock {
  const { total_count: total, memories: summaries } = store.getLivingReferences(space, limit);
  const memories = presentHotMemories(summaries);

  return {
    total,
    returned_count: memories.length,
    coverage: determineTrendingCoverage(memories.length, total),
    memories,
  };
}
