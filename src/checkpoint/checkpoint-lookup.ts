// ── Checkpoint lookup helpers ──

import type { MindStore } from '../store/mind-store';
import type { MemorySummary } from '../types';

const CHECKPOINT_BATCH_SIZE = 500;

/**
 * Fetch every checkpoint in a space across all tiers (T1, T2, and T3).
 * `listMemories` defaults to T1+T2, so active checkpoints that were demoted to
 * T3 would otherwise be invisible.
 */
export async function fetchAllCheckpoints(
  store: MindStore,
  space: string
): Promise<MemorySummary[]> {
  const total = await store.queryMemoriesCount({ space, tag: 'checkpoint' });
  if (total === 0) {
    return [];
  }

  const checkpoints: MemorySummary[] = [];
  for (let offset = 0; offset < total; offset += CHECKPOINT_BATCH_SIZE) {
    checkpoints.push(
      ...store.queryMemories({
        space,
        tag: 'checkpoint',
        limit: CHECKPOINT_BATCH_SIZE,
        offset,
      })
    );
  }
  return checkpoints;
}

/** Find the most recently changed active checkpoint, regardless of tier. */
export async function findActiveCheckpoint(
  store: MindStore,
  space: string
): Promise<MemorySummary | null> {
  const checkpoints = await fetchAllCheckpoints(store, space);
  return checkpoints.find(checkpoint => checkpoint.tags.includes('active')) ?? null;
}
