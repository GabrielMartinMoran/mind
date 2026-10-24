// ── Core domain types for Mind v2 ──

export interface Space {
  name: string;
  description: string;
  tags: string[];
  hidden: boolean;
  id?: string; // UUID, optional for backward compat in public APIs
  created_at: string;
  updated_at: string;
}

export interface SpaceTierCounts {
  t1: number;
  t2: number;
  t3: number;
}

export interface SpaceSummary {
  name: string;
  description: string;
  tags: string[];
  hidden: boolean;
  memory_count: number;
  tier_counts: SpaceTierCounts;
}

export interface Memory {
  id: string; // UUID primary key
  space_name: string;
  space_id: string; // UUID of parent space
  name: string;
  content: string;
  tier: Tier;
  pinned: boolean;
  fts_id?: number; // Integer surrogate for FTS5 rowid (optional, not present in all public-facing contexts)
  access_count: number;
  last_accessed_at: string | null;
  embedding: Float32Array | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  changed_at: string;
}

export interface MemorySummary {
  id: string; // UUID
  space_name: string;
  space_id: string; // UUID of parent space
  name: string;
  tier: Tier;
  pinned: boolean;
  tags: string[];
  access_count: number;
  created_at: string;
  updated_at: string;
  changed_at: string;
}

export type LinkDirection = 'outgoing' | 'incoming';

export interface Link {
  source_id: string;
  target_id: string;
  source_name: string;
  source_space: string;
  target_name: string;
  target_space: string;
  label: string;
  created_at: string;
}

export type Tier = 1 | 2 | 3;

export interface TierChange {
  from: Tier;
  to: Tier;
  reason: 'promote' | 'demote' | 'auto_promote';
}

export interface BoundedMemorySummaryResult {
  total_count: number;
  memories: MemorySummary[];
}

export interface HotMemorySummary {
  id: string;
  name: string;
  tier: Tier;
  tags: string[];
  pinned: boolean;
  updated_at: string;
}

export interface SearchFilter {
  space?: string;
  tag?: string;
  tier?: Tier;
  /** Inclusive multi-tier restriction. Takes precedence over `tier` when non-empty. */
  tiers?: Tier[];
}

export interface SearchResult {
  id: string;
  space_name: string;
  name: string;
  content: string;
  tier: Tier;
  pinned: boolean;
  tags: string[];
  rank: number;
  similarity?: number;
  created_at: string;
  updated_at: string;
  changed_at: string;
}

export interface MemoryQueryFilter {
  space?: string;
  tag?: string;
  tier?: Tier;
  /** Inclusive multi-tier restriction. Takes precedence over `tier` when non-empty. */
  tiers?: Tier[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface StatusResult {
  db_path: string;
  db_size_bytes: number;
  total_spaces: number;
  total_memories: number;
  /** Always contains entries for all 3 tiers, even if count is 0 */
  by_tier: { tier: Tier; count: number; pinned: number }[];
  /** RAG / embeddings info */
  rag_enabled: boolean;
  embeddings_indexed: number;
}

export interface GraphNodeSummary {
  id: string;
  name: string;
  tier: Tier;
  links_to: string[];
  linked_by: string[];
}

export interface SpaceGraphResult {
  nodes: GraphNodeSummary[];
  meta: {
    total_nodes: number;
    returned_nodes: number;
    requested_limit: number;
    applied_limit: number;
    max_limit: number;
    truncated: boolean;
  };
}

/** Legacy brain.json format for migration */
export interface LegacyBrain {
  [spaceName: string]: {
    description: string;
    memories: { name: string; description: string }[];
  };
}

// ── Log system types ──

export type LogSource = 'cli' | 'mcp' | 'api';
export type LogLevel = 'info' | 'warn' | 'error';

export interface CallerInfo {
  ip?: string;
  userAgent?: string;
  sessionId?: string;
  mcpSession?: string;
}

export interface LogEntry {
  id: number; // KEEP numeric — logs.id is unchanged
  source: LogSource;
  operation: string;
  level: LogLevel;
  input_data: string | null;
  output_data: string | null;
  error_message: string | null;
  caller_info: string | null;
  duration_ms: number | null;
  timestamp: string;
}

export interface LogFilter {
  source?: string;
  operation?: string;
  search?: string;
  from?: string;
  to?: string;
  level?: LogLevel;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface LogQueryResult {
  logs: LogEntry[];
  total: number;
  limit: number;
  offset: number;
}
