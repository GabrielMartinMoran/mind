// ── LinkRepository: handles all link operations (v8: UUID memory ids, join spaces for space_name) ──

import type { Database } from 'bun:sqlite';

import type { Link } from '../../types';
import { now, requireMemory } from '../shared';

export interface LinkRepository {
  linkMemories(sourceId: string, targetId: string, label?: string): void;
  unlinkMemories(sourceId: string, targetId: string): void;
  getLinks(memoryId: string): Link[];
}

export function createLinkRepository(db: Database): LinkRepository {
  function linkMemories(sourceId: string, targetId: string, label?: string): void {
    requireMemory(db, sourceId);
    requireMemory(db, targetId);
    if (sourceId === targetId) throw new Error('Cannot link a memory to itself');

    const ts = now();
    db.run(
      'INSERT OR REPLACE INTO links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)',
      [sourceId, targetId, label ?? 'related', ts]
    );
  }

  function unlinkMemories(sourceId: string, targetId: string): void {
    db.run('DELETE FROM links WHERE source_id = ? AND target_id = ?', [sourceId, targetId]);
  }

  function getLinks(memoryId: string): Link[] {
    const rows = db
      .query(
        `SELECT l.*,
                        sm.name as source_name, ss.name as source_space,
                        tm.name as target_name, st.name as target_space
                 FROM links l
                 JOIN memories sm ON sm.id = l.source_id
                 JOIN spaces ss ON ss.id = sm.space_id
                 JOIN memories tm ON tm.id = l.target_id
                 JOIN spaces st ON st.id = tm.space_id
                 WHERE l.source_id = ? OR l.target_id = ?
                 ORDER BY l.created_at DESC, l.rowid DESC`
      )
      .all(memoryId, memoryId) as any[];

    return rows.map(r => ({
      source_id: r.source_id,
      target_id: r.target_id,
      source_name: r.source_name,
      source_space: r.source_space,
      target_name: r.target_name,
      target_space: r.target_space,
      label: r.label,
      created_at: r.created_at,
    }));
  }

  return {
    linkMemories,
    unlinkMemories,
    getLinks,
  };
}
