import { fetchAllCheckpoints } from '../../checkpoint/checkpoint-lookup';
import { fetchCheckpointContent } from '../../helpers/checkpoint-content';
import type { MindStore } from '../../store/mind-store';
import type { MemorySummary } from '../../types';

import { filterByDateRange } from './date-filter';

export interface CheckpointSummary {
  name: string;
  goal: string;
  pending: string;
  changed_at: string;
  tags: string[];
}

export function applyCheckpointFilters(
  checkpoints: MemorySummary[],
  status?: string,
  tag?: string,
  from?: string,
  to?: string
): MemorySummary[] {
  let filtered = checkpoints;

  if (status && status !== 'all') {
    filtered = filtered.filter(memory => memory.tags.includes(status));
  }

  if (tag) {
    filtered = filtered.filter(memory => memory.tags.includes(tag));
  }

  return filterByDateRange(filtered, from, to);
}

export function applyCheckpointSortAndPagination(
  checkpoints: MemorySummary[],
  offset: number,
  limit: number
): { items: MemorySummary[]; total: number } {
  const sorted = [...checkpoints].sort(
    (a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime()
  );
  const total = sorted.length;
  const items = sorted.slice(offset, offset + limit);
  return { items, total };
}

export async function fetchCheckpointSummaries(
  store: MindStore,
  checkpoints: MemorySummary[]
): Promise<CheckpointSummary[]> {
  return Promise.all(checkpoints.map(memory => buildCheckpointSummary(store, memory)));
}

export async function buildCheckpointSummary(
  store: MindStore,
  memory: MemorySummary
): Promise<CheckpointSummary> {
  const full = store.getMemoryById(memory.id);
  const parsedContent = full ? fetchCheckpointContent(full) : null;

  return {
    name: memory.name,
    goal: parsedContent?.goal ?? '',
    pending: parsedContent?.pending ?? '',
    changed_at: memory.changed_at,
    tags: memory.tags,
  };
}

export async function fetchAllCheckpointMemories(
  store: MindStore,
  space: string
): Promise<MemorySummary[]> {
  return fetchAllCheckpoints(store, space);
}
