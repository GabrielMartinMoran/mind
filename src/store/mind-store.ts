// ── MindStore interface ──

import type { ExportResult } from '../sync/types';
import type {
  Space,
  SpaceSummary,
  Memory,
  MemorySummary,
  Link,
  LinkDirection,
  Tier,
  SearchFilter,
  MemoryQueryFilter,
  SearchResult,
  StatusResult,
  SpaceGraphResult,
  LegacyBrain,
  HotMemorySummary,
  BoundedMemorySummaryResult,
} from '../types';

import type { ScoredSearchResult } from './repositories/search-repository';

export interface LinkedMemorySummary {
  id: string;
  name: string;
  space_name: string;
  changed_at: string;
  tier: Tier;
  tags: string[];
  pinned: boolean;
  label: string;
  direction: LinkDirection;
}

export interface MemoryPatchInput {
  name?: string;
  content?: string;
  pinned?: boolean;
  tierTransition?: 'promote' | 'demote';
  addTags?: string[];
  removeTags?: string[];
  addLinksToIds?: string[];
  removeLinksToIds?: string[];
}

/** Optional pagination for relevance search. Surfaces supply their own defaults. */
export interface SearchPagination {
  /** Maximum results to return; clamped by the store to 1..500. Omit for unbounded. */
  limit?: number;
  /** Zero-based offset into the ranked results. */
  offset?: number;
}

export interface MindStore {
  // Spaces
  createSpace(name: string, description: string, tags?: string[]): void;
  getSpace(name: string): Space | null;
  listSpaces(filter?: { tag?: string; includeHidden?: boolean }): SpaceSummary[];
  updateSpace(name: string, updates: { description?: string; hidden?: boolean }): void;
  deleteSpace(name: string): void;
  renameSpace(oldName: string, newName: string): void;
  addSpaceTag(space: string, tag: string): void;
  removeSpaceTag(space: string, tag: string): void;

  // Memories
  addMemory(
    space: string,
    name: string,
    content: string,
    opts?: { tags?: string[]; tier?: Tier; pinned?: boolean; linksToIds?: string[] }
  ): Promise<Memory>;
  getMemory(space: string, name: string): Memory | null;
  getMemoryById(id: string): Memory | null;
  /**
   * List memories in a space.
   * Default (no tier filter): returns T1 + T2 only.
   * Passing tier 3 will return T3 memories.
   * T4 has been removed — listing with tier=3 or no filter only.
   */
  listMemories(space: string, filter?: { tier?: Tier; tag?: string }): MemorySummary[];
  /**
   * Get hot (T1 + T2) memories as summaries for a space.
   * Used by MCP tools to provide a fast overview without full content.
   */
  getHotMemories(space: string): HotMemorySummary[];
  updateMemory(id: string, updates: { name?: string; content?: string }): Promise<void>;
  moveMemory(
    id: string,
    updates: { space: string; name?: string; content?: string; tier?: Tier }
  ): Promise<Memory>;
  deleteMemory(id: string): void;
  deleteMemoryByName(space: string, name: string): void;
  /**
   * Record an access (bumps count + last_accessed_at).
   * Also auto-promotes non-pinned memories one tier up (with LRU eviction if destination is full).
   * Silently skips promotion if destination is full and all are pinned.
   */
  recordAccess(id: string): void;
  getLinkedMemorySummaries(memoryId: string): {
    links_to: LinkedMemorySummary[];
    linked_by: LinkedMemorySummary[];
  };
  patchMemory(id: string, patch: MemoryPatchInput): Promise<Memory>;

  // Tags
  addMemoryTag(memoryId: string, tag: string): void;
  removeMemoryTag(memoryId: string, tag: string): void;
  setMemoryTags(memoryId: string, tags: string[]): void;
  listAllTags(): {
    spaces: { tag: string; count: number }[];
    memories: { tag: string; count: number }[];
  };

  // Tiers
  /**
   * Promote memory one tier up (T3→T2, T2→T1).
   * Evicts LRU non-pinned from destination if full.
   * Throws if already at T1 or destination is full and all are pinned.
   */
  promote(id: string): void;
  /**
   * Demote memory one tier down (T1→T2, T2→T3).
   * Throws if already at lowest tier (T3).
   */
  demote(id: string): void;
  pin(id: string): void;
  unpin(id: string): void;

  // Links
  link(sourceId: string, targetId: string, label?: string): void;
  unlink(sourceId: string, targetId: string): void;
  getLinks(memoryId: string): Link[];

  // Search (T4 memories are no longer applicable - T3 is unlimited)
  // Unified multi-channel pipeline (D1). Returns fused score, confidence and
  // provenance per result. Optional pagination applies after ranking; when
  // omitted the full ordered set is returned (the eval harness relies on this).
  search(query: string, filter?: SearchFilter & SearchPagination): Promise<ScoredSearchResult[]>;

  // Search with fallback chain: FTS5 → LIKE → embeddings; returns results + search_method
  searchFallback(
    query: string,
    filter?: SearchFilter
  ): Promise<{ results: SearchResult[]; search_method: string }>;

  // Query memories by metadata/date with pagination
  queryMemories(filter?: MemoryQueryFilter): MemorySummary[];

  // Count memories matching the given filters (without fetching all rows)
  queryMemoriesCount(filter: {
    space?: string;
    tag?: string;
    tier?: number;
    from?: string;
    to?: string;
  }): Promise<number>;

  // Bounded space-orientation queries (checkpoints excluded, pinned first)
  getTrendingMemories(space: string, tier: Tier, limit: number): BoundedMemorySummaryResult;
  getLivingReferences(space: string, limit: number): BoundedMemorySummaryResult;

  // Graph view (includes T1..T3 only)
  getSpaceGraph(space: string, opts?: { limit?: number; maxLimit?: number }): SpaceGraphResult;

  // Status
  getStatus(space?: string): StatusResult;

  // Migration
  importFromJson(brain: LegacyBrain): void;
  /**
   * Parse a memory reference string "space:name" into its components.
   * Returns null if the format is invalid (no colon, empty space, or empty name).
   */
  resolveMemoryRef(ref: string): { space: string; name: string } | null;

  // Logs
  addLog(entry: {
    source: 'cli' | 'mcp' | 'api';
    operation: string;
    level?: 'info' | 'warn' | 'error';
    inputData?: Record<string, unknown>;
    outputData?: Record<string, unknown>;
    errorMessage?: string;
    callerInfo?: Record<string, unknown>;
    durationMs?: number;
  }): void;
  queryLogs(filter?: {
    source?: string;
    operation?: string;
    search?: string;
    from?: string;
    to?: string;
    level?: 'info' | 'warn' | 'error';
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
    since?: number;
  }): { logs: any[]; total: number; limit: number; offset: number };
  cleanupOldLogs(retentionMinutes: number): number;
  clearAllLogs(): number;
  subscribeToLogs(sessionId: string, controller: any, filter?: string): void;
  unsubscribeFromLogs(sessionId: string): void;

  // Sync operations (Phase 1: export only)
  exportSpaceToFiles(space: string, basePath: string): Promise<ExportResult>;

  // Lifecycle
  close(): void;
}
