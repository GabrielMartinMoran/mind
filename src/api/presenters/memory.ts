import type { Memory, Tier } from '../../types';

/** Memory detail shape exposed by the HTTP API. */
export interface MemoryDetail {
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: Tier;
  pinned: boolean;
  access_count: number;
  last_accessed_at: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  changed_at: string;
}

/**
 * Maps the persistence model to the API detail contract, dropping internal
 * storage fields (`embedding`, `fts_id`, `space_id`) that the UI never needs.
 */
export function presentMemoryDetail(memory: Memory): MemoryDetail {
  return {
    id: memory.id,
    space_name: memory.space_name,
    name: memory.name,
    content: memory.content,
    tier: memory.tier,
    pinned: memory.pinned,
    access_count: memory.access_count,
    last_accessed_at: memory.last_accessed_at,
    tags: memory.tags,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    changed_at: memory.changed_at,
  };
}
