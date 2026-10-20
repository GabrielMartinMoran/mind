// Minimal memory-engine adapter contract.
//
// This mirrors the conceptual surface of `agent-memory-bench` (MIT) as
// documented in the research report: prepare/reset a store, ingest items, then
// search/retrieve and clean up. The concrete adapters for the pinned Mind
// engines (v9/v10) are implemented in T3; Mem0 is documented only (see
// README). Keeping the contract pure lets every engine be driven and faked the
// same way.

export interface EngineInsertMeta {
  /** Speaker of a dialogue turn. */
  readonly speaker?: string;
  /** Session identifier (LoCoMo `session_n`). */
  readonly session?: string | number;
  /** Timestamp string attached to the turn. */
  readonly timestamp?: string;
  /** Stable source id (LoCoMo `dia_id`). */
  readonly diaId?: string;
  readonly tags?: readonly string[];
}

export interface EngineFragment {
  readonly text: string;
  readonly score: number;
  readonly source?: string;
  readonly name?: string;
  readonly spaceName?: string;
}

export interface EngineSearchResult {
  readonly chunks: readonly EngineFragment[];
  readonly latencyMs: number;
  readonly context?: string;
  /** Which native score field the engine used; adapters normalise to `score`. */
  readonly nativeScoreKind?: 'rank' | 'score' | 'similarity' | 'unknown';
}

export interface EngineInsertItem {
  readonly text: string;
  readonly meta?: EngineInsertMeta;
}

export interface MemoryEngine {
  /** Stable engine id, e.g. `mind-v9`, `mind-v10`, `no-memory`. */
  readonly id: string;
  /** Prepare a fresh store for a run key. */
  reset(runKey: string): Promise<void>;
  /** Insert one item; returns the recorded insertion latency in milliseconds. */
  insert(userKey: string, text: string, meta?: EngineInsertMeta): Promise<number>;
  /** Optional batch insert; returns the number of inserted items. */
  insertMany?(userKey: string, items: readonly EngineInsertItem[]): Promise<number>;
  /** Signal that ingestion is complete. */
  flush(userKey: string): Promise<void>;
  /** Return up to `k` ranked fragments for a query. */
  search(userKey: string, query: string, k: number): Promise<EngineSearchResult>;
  /** Optional retrieval of a single item by its stable id/name. */
  retrieve?(userKey: string, id: string): Promise<EngineFragment | null>;
  /** Release resources for a run key. */
  cleanup(userKey: string): Promise<void>;
}
