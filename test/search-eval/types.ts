// ── Shared types for the search evaluation suite ──

import type { Tier } from '../../src/types';

/** Where a fixture case came from. `emulated` mirrors real usage; `lab` is synthetic. */
export type CaseOrigin = 'emulated' | 'lab';

/** Difficulty ladder: N0 trivial → N4 extreme. */
export type CaseLevel = 'N0' | 'N1' | 'N2' | 'N3' | 'N4';

/** Match/semantic class of a case. */
export type CaseType =
  | 'exact'
  | 'prefix'
  | 'phrase'
  | 'and'
  | 'or'
  | 'not'
  | 'typo'
  | 'substring'
  | 'bilingual'
  | 'identifier'
  | 'filter'
  | 'negative'
  // ── v2-only axes (added for the expanded suite) ──
  | 'diacritics'
  | 'first3typo'
  | 'transposition'
  | 'insertion'
  | 'deletion'
  | 'querylength'
  | 'longmemory'
  | 'frequent'
  | 'shorttoken'
  | 'nearDuplicate'
  | 'anti_bias'
  | 'neutral';

/** Search parameters a case exercises (subset of the public search filter + limit). */
export interface CaseParams {
  space?: string;
  tier?: Tier;
  tag?: string;
  limit?: number;
}

/** A fully specified fixture evaluation case. `expected` is always explicit. */
export interface EvalCase {
  id: string;
  query: string;
  params: CaseParams;
  /** Canonical memory refs ("space::name") that a correct engine should return. */
  expected: string[];
  /** Per-case difficulty. */
  level: CaseLevel;
  origin: CaseOrigin;
  type: CaseType;
  /** True when this case directly mirrors a real query shape from the evidence file. */
  realShape?: boolean;
  notes?: string;
}

/** Presence classification for a real query against the scanned corpus. */
export type PresenceClass = 'all-tokens-present' | 'partial' | 'absent';

/** A curated real query with scan-derived ground truth (local runner only). */
export interface RealCase {
  id: string;
  query: string;
  space: string | null;
  params: CaseParams;
  /** Scan-derived expected refs (which memories contain the significant tokens). */
  expected: string[];
  scan_hit_count: number;
  presence: PresenceClass;
  notes?: string;
}

export interface RealCasesFile {
  metadata: {
    generated_at: string;
    source_db: string;
    access_mode: string;
    label_method: string;
    scope: string;
    token_rule: string;
  };
  cases: RealCase[];
}
