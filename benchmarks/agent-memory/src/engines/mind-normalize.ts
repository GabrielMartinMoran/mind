// Normalise `/api/search` payloads from the Mind engines to one shape.
//
// The engines expose the same endpoint but different score fields: v9 items
// carry `rank` (its `similarity` is undefined and JSON-dropped when RAG is off);
// v10 and the current checkout carry additive `score`/`confidence`/`methods`.
// The array order is authoritative for ranking in every version, so it is
// preserved as `rankPosition`.

import type { EngineVersion } from '../config';

export interface MindSearchRow {
  /** Memory name; for A1 this is the LoCoMo `dia_id`. */
  readonly ref: string;
  readonly space: string;
  readonly content: string;
  /** 1-based position in the returned array (authoritative ranking). */
  readonly rankPosition: number;
  readonly nativeScoreKind: 'rank' | 'score';
  readonly nativeScore: number | null;
  readonly confidence?: string;
  readonly methods?: readonly string[];
}

export interface MindSearchResponse {
  readonly rows: readonly MindSearchRow[];
  /** Wall-clock latency of the HTTP call in milliseconds. */
  readonly latencyMs: number;
}

function toNativeScore(record: Record<string, unknown>, version: EngineVersion): number | null {
  const raw = version === 'v9' ? record.rank : record.score;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Map raw API items to normalised rows, preserving array order. Items without
 * a string `name` are dropped (they cannot be matched against evidence).
 */
export function normalizeSearchItems(
  items: readonly unknown[],
  version: EngineVersion
): MindSearchRow[] {
  const kind: 'rank' | 'score' = version === 'v9' ? 'rank' : 'score';
  const rows: MindSearchRow[] = [];

  items.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const ref = typeof record.name === 'string' ? record.name : null;
    if (!ref) return;

    const methods = Array.isArray(record.methods)
      ? record.methods.filter((method): method is string => typeof method === 'string')
      : undefined;

    rows.push({
      ref,
      space: typeof record.space_name === 'string' ? record.space_name : '',
      content: typeof record.content === 'string' ? record.content : '',
      rankPosition: index + 1,
      nativeScoreKind: kind,
      nativeScore: toNativeScore(record, version),
      ...(version !== 'v9' && typeof record.confidence === 'string'
        ? { confidence: record.confidence }
        : {}),
      ...(version !== 'v9' && methods ? { methods } : {}),
    });
  });

  return rows;
}
