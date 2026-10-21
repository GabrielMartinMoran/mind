// Read-only inspection of a Mind SQLite database.
//
// The benchmark verifies ingestion by reading the pinned engine's database
// directly (read-only) instead of parsing CLI output. The query works on both
// schema 8 (v9) and schema 10 (v10): both normalise memories onto `spaces` via
// `memories.space_id` and keep the memory name in `memories.name`.

import { Database } from 'bun:sqlite';

export interface MemorySetInfo {
  readonly count: number;
  readonly distinctNames: number;
  readonly names: readonly string[];
}

/** Memory names in `space`, sorted, plus count totals. */
export function readMemoryNames(dbPath: string, space: string): MemorySetInfo {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT m.name) AS dc
           FROM memories m JOIN spaces s ON m.space_id = s.id
          WHERE s.name = ?`
      )
      .get(space) as { c: number; dc: number } | undefined;
    const names = (
      db
        .query(
          `SELECT m.name AS n
             FROM memories m JOIN spaces s ON m.space_id = s.id
            WHERE s.name = ?
            ORDER BY m.name`
        )
        .all(space) as { n: string }[]
    ).map(r => r.n);
    return { count: row?.c ?? 0, distinctNames: row?.dc ?? 0, names };
  } finally {
    db.close();
  }
}

// ── Read-only assertion helpers (benchmark B) ───────────────────────────────

export interface InspectedMemory {
  readonly name: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly tier: 1 | 2 | 3;
  readonly pinned: boolean;
  readonly changedAt: string;
}

function openReadOnly(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

function parseTags(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? value.split(',').sort() : [];
}

/** All memories in `space`, with tags and lifecycle metadata. Read-only. */
export function inspectMemories(dbPath: string, space: string): InspectedMemory[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query(
        `SELECT m.name AS name, m.content AS content, m.tier AS tier,
                m.pinned AS pinned, m.changed_at AS changed_at,
                COALESCE(GROUP_CONCAT(mt.tag, ','), '') AS tags
           FROM memories m
           JOIN spaces s ON m.space_id = s.id
           LEFT JOIN memory_tags mt ON mt.memory_id = m.id
          WHERE s.name = ?
          GROUP BY m.id
          ORDER BY m.name`
      )
      .all(space) as {
      name: string;
      content: string;
      tier: number;
      pinned: number;
      changed_at: string;
      tags: string;
    }[];
    return rows.map(row => ({
      name: row.name,
      content: row.content,
      tags: parseTags(row.tags),
      tier: row.tier as 1 | 2 | 3,
      pinned: row.pinned === 1,
      changedAt: row.changed_at,
    }));
  } finally {
    db.close();
  }
}

export interface InspectedSpacedMemory extends InspectedMemory {
  readonly space: string;
}

/** Every memory across every space, with its space name. Read-only. */
export function inspectAllMemories(dbPath: string): InspectedSpacedMemory[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query(
        `SELECT s.name AS space, m.name AS name, m.content AS content, m.tier AS tier,
                m.pinned AS pinned, m.changed_at AS changed_at,
                COALESCE(GROUP_CONCAT(mt.tag, ','), '') AS tags
           FROM memories m
           JOIN spaces s ON m.space_id = s.id
           LEFT JOIN memory_tags mt ON mt.memory_id = m.id
          GROUP BY m.id
          ORDER BY s.name, m.name`
      )
      .all() as {
      space: string;
      name: string;
      content: string;
      tier: number;
      pinned: number;
      changed_at: string;
      tags: string;
    }[];
    return rows.map(row => ({
      space: row.space,
      name: row.name,
      content: row.content,
      tags: parseTags(row.tags),
      tier: row.tier as 1 | 2 | 3,
      pinned: row.pinned === 1,
      changedAt: row.changed_at,
    }));
  } finally {
    db.close();
  }
}

export interface InspectedEmbeddingCoverage {
  readonly name: string;
  readonly hasEmbedding: boolean;
}

/**
 * Embedding presence per memory in `space`. Reports only a boolean; raw vectors
 * are never read out of SQLite. Read-only.
 */
export function inspectEmbeddingCoverage(
  dbPath: string,
  space: string,
  names?: readonly string[]
): InspectedEmbeddingCoverage[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query(
        `SELECT m.name AS name,
                (m.embedding IS NOT NULL AND length(m.embedding) > 0) AS has_embedding
           FROM memories m
           JOIN spaces s ON m.space_id = s.id
          WHERE s.name = ?
          ORDER BY m.name`
      )
      .all(space) as { name: string; has_embedding: number }[];
    const wanted = names ? new Set(names) : null;
    return rows
      .filter(row => wanted === null || wanted.has(row.name))
      .map(row => ({ name: row.name, hasEmbedding: row.has_embedding === 1 }));
  } finally {
    db.close();
  }
}

export interface InspectedLink {
  readonly source: string;
  readonly target: string;
  readonly label: string;
  /** Direction relative to the reference memory, when one was requested. */
  readonly direction?: 'outgoing' | 'incoming';
  readonly createdAt: string;
}

/**
 * Links touching `space`. When `memoryName` is given, only links that touch
 * that memory are returned and `direction` is set relative to it. Read-only.
 */
export function inspectLinks(dbPath: string, space: string, memoryName?: string): InspectedLink[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query(
        `SELECT sm.name AS source, tm.name AS target, l.label AS label,
                l.created_at AS created_at
           FROM links l
           JOIN memories sm ON sm.id = l.source_id
           JOIN spaces ss ON ss.id = sm.space_id
           JOIN memories tm ON tm.id = l.target_id
           JOIN spaces ts ON ts.id = tm.space_id
          WHERE ss.name = ? OR ts.name = ?
          ORDER BY l.created_at, sm.name, tm.name`
      )
      .all(space, space) as {
      source: string;
      target: string;
      label: string;
      created_at: string;
    }[];
    return rows
      .filter(row => !memoryName || row.source === memoryName || row.target === memoryName)
      .map(row => ({
        source: row.source,
        target: row.target,
        label: row.label,
        createdAt: row.created_at,
        ...(memoryName
          ? { direction: row.source === memoryName ? ('outgoing' as const) : ('incoming' as const) }
          : {}),
      }));
  } finally {
    db.close();
  }
}

/** Every link across every space (names only, no space qualification). Read-only. */
export function inspectAllLinks(dbPath: string): InspectedLink[] {
  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .query(
        `SELECT sm.name AS source, tm.name AS target, l.label AS label,
                l.created_at AS created_at
           FROM links l
           JOIN memories sm ON sm.id = l.source_id
           JOIN memories tm ON tm.id = l.target_id
          ORDER BY l.created_at, sm.name, tm.name`
      )
      .all() as {
      source: string;
      target: string;
      label: string;
      created_at: string;
    }[];
    return rows.map(row => ({
      source: row.source,
      target: row.target,
      label: row.label,
      createdAt: row.created_at,
    }));
  } finally {
    db.close();
  }
}

export interface InspectedMemoryTags {
  readonly name: string;
  readonly tags: readonly string[];
  readonly tier: 1 | 2 | 3;
}

function inspectByTag(dbPath: string, space: string, tag: string): InspectedMemoryTags[] {
  return inspectMemories(dbPath, space)
    .filter(memory => memory.tags.includes(tag))
    .map(memory => ({ name: memory.name, tags: memory.tags, tier: memory.tier }));
}

/** Active checkpoints in `space` (memories tagged `checkpoint`). Read-only. */
export function inspectCheckpoints(dbPath: string, space: string): InspectedMemoryTags[] {
  return inspectByTag(dbPath, space, 'checkpoint');
}

/**
 * Session summaries in `space`. Per the memory protocol they carry both
 * `type:session` and `cat:summary`; requiring both keeps live checkpoints (which
 * may also carry `type:session`) out of the result. Read-only.
 */
export function inspectSessionSummaries(dbPath: string, space: string): InspectedMemoryTags[] {
  return inspectMemories(dbPath, space)
    .filter(memory => memory.tags.includes('type:session') && memory.tags.includes('cat:summary'))
    .map(memory => ({ name: memory.name, tags: memory.tags, tier: memory.tier }));
}

export interface MemorySetVerification {
  readonly ok: boolean;
  readonly expected: number;
  readonly count: number;
  readonly distinctNames: number;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly detail: string;
}

/**
 * Assert that the stored memory set for `space` exactly equals `expectedNames`:
 * same count, no duplicates, and equal name sets (no missing / unexpected).
 */
export function verifyMemorySet(
  dbPath: string,
  space: string,
  expectedNames: readonly string[]
): MemorySetVerification {
  const info = readMemoryNames(dbPath, space);
  const expectedSet = new Set(expectedNames);
  const actualSet = new Set(info.names);
  const missing = [...expectedSet].filter(name => !actualSet.has(name));
  const unexpected = [...actualSet].filter(name => !expectedSet.has(name));
  const duplicates = info.count - info.distinctNames;
  const ok =
    info.count === expectedNames.length &&
    duplicates === 0 &&
    missing.length === 0 &&
    unexpected.length === 0;
  const detail = ok
    ? `${info.count} memories, name set matches ${expectedNames.length} expected dia_ids`
    : `count=${info.count} expected=${expectedNames.length} duplicates=${duplicates} ` +
      `missing=${missing.length} unexpected=${unexpected.length}`;
  return {
    ok,
    expected: expectedNames.length,
    count: info.count,
    distinctNames: info.distinctNames,
    missing,
    unexpected,
    detail,
  };
}
