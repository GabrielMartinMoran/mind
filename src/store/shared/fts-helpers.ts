// ── FTS helper class for manual FTS5 sync ──
// bun:sqlite has a bug with content-sync triggers, so FTS is synced manually.
//
// Single sync seam for BOTH standalone FTS tables (main porter index and the
// v10 trigram substring index). Every add/update/delete/import/space-cascade
// path goes through this helper, so the two indexes stay in lockstep and the
// per-store P-A vocabulary cache is invalidated on every document write.

import type { Database } from 'bun:sqlite';

import { bumpStoreGeneration } from './matching-tokenizer';

const MAIN_FTS = 'memories_fts';
const TRIGRAM_FTS = 'memories_fts_trigram';

export class FtsHelper {
  constructor(private db: Database) {}

  /**
   * Insert a memory into both FTS indexes.
   * @param memoryId - UUID primary key (unused for indexing; kept for symmetry)
   * @param ftsId - the integer surrogate for FTS5 rowid (not the UUID)
   */
  insert(memoryId: string, ftsId: number, name: string, content: string): void {
    this.db.run(`INSERT INTO ${MAIN_FTS}(rowid, name, content) VALUES (?, ?, ?)`, [
      ftsId,
      name,
      content,
    ]);
    this.db.run(`INSERT INTO ${TRIGRAM_FTS}(rowid, name, content) VALUES (?, ?, ?)`, [
      ftsId,
      name,
      content,
    ]);
    bumpStoreGeneration(this.db);
  }

  /**
   * Delete a memory from both FTS indexes.
   * @param memoryId - UUID primary key (unused for indexing; kept for symmetry)
   * @param ftsId - the integer surrogate for FTS5 rowid
   */
  delete(memoryId: string, ftsId: number): void {
    this.db.run(`DELETE FROM ${MAIN_FTS} WHERE rowid = ?`, [ftsId]);
    this.db.run(`DELETE FROM ${TRIGRAM_FTS} WHERE rowid = ?`, [ftsId]);
    bumpStoreGeneration(this.db);
  }

  /**
   * Update a memory in both FTS indexes (delete + insert). Both share the
   * caller's transaction, so a failure leaves memory and both indexes unchanged.
   * @param memoryId - UUID primary key (unused for indexing; kept for symmetry)
   * @param ftsId - the integer surrogate for FTS5 rowid
   */
  update(memoryId: string, ftsId: number, name: string, content: string): void {
    this.delete(memoryId, ftsId);
    this.insert(memoryId, ftsId, name, content);
  }
}

/**
 * Repopulate the contentless trigram index from `memories`.
 *
 * The v10 trigram index is `content='', contentless_delete=1`, where FTS5's
 * `'rebuild'` command is unsupported. Recovery therefore wipes the index with
 * `'delete-all'` and re-inserts every memory by rowid. Only the index is
 * touched; memory rows are never read for mutation.
 */
export function recoverTrigramIndex(db: Database): void {
  db.exec(`INSERT INTO ${TRIGRAM_FTS}(${TRIGRAM_FTS}) VALUES('delete-all')`);
  db.exec(
    `INSERT INTO ${TRIGRAM_FTS}(rowid, name, content) SELECT fts_id, name, content FROM memories`
  );
}

/**
 * Logical-consistency problems of the trigram index (empty array = healthy):
 * count parity with `memories` plus orphan rowids (index rows with no memory).
 */
export function trigramIndexProblems(db: Database): string[] {
  const problems: string[] = [];

  const counts = db
    .query(
      `SELECT (SELECT COUNT(*) FROM memories) AS memories,
              (SELECT COUNT(*) FROM ${TRIGRAM_FTS}) AS trigram`
    )
    .get() as { memories: number; trigram: number };
  if (counts.memories !== counts.trigram) {
    problems.push(`trigram has ${counts.trigram} rows for ${counts.memories} memories`);
  }

  const orphans = (
    db
      .query(
        `SELECT COUNT(*) AS c FROM ${TRIGRAM_FTS} tri
         LEFT JOIN memories m ON m.fts_id = tri.rowid
         WHERE m.id IS NULL`
      )
      .get() as { c: number }
  ).c;
  if (orphans > 0) problems.push(`${orphans} orphan trigram rows without a memory`);

  return problems;
}
