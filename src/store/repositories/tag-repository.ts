// ── TagRepository: handles all tag operations ──

import type { Database } from 'bun:sqlite';

import { normalizeTag, normalizeTags } from '../../helpers/tags';

export interface TagRepository {
  addMemoryTag(memoryId: string, tag: string): void;
  removeMemoryTag(memoryId: string, tag: string): void;
  setMemoryTags(memoryId: string, tags: string[]): void;
  listAllTags(): {
    spaces: { tag: string; count: number }[];
    memories: { tag: string; count: number }[];
  };
  listMemoryTags(spaceName: string): string[];
}

export function createTagRepository(db: Database): TagRepository {
  function addMemoryTag(memoryId: string, tag: string): void {
    const normalized = normalizeTag(tag);
    db.run('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)', [
      memoryId,
      normalized,
    ]);
  }

  function removeMemoryTag(memoryId: string, tag: string): void {
    const normalized = normalizeTag(tag);
    db.run('DELETE FROM memory_tags WHERE memory_id = ? AND tag = ?', [memoryId, normalized]);
  }

  function setMemoryTags(memoryId: string, tags: string[]): void {
    const transaction = db.transaction(() => {
      // Clear existing tags
      db.run('DELETE FROM memory_tags WHERE memory_id = ?', [memoryId]);
      // Add new tags
      if (tags.length > 0) {
        const normalizedTags = normalizeTags(tags);
        const stmt = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
        for (const tag of normalizedTags) {
          stmt.run(memoryId, tag);
        }
      }
    });
    transaction();
  }

  function listAllTags(): {
    spaces: { tag: string; count: number }[];
    memories: { tag: string; count: number }[];
  } {
    const spaceTags = db
      .query('SELECT tag, COUNT(*) as count FROM space_tags GROUP BY tag ORDER BY tag')
      .all() as {
      tag: string;
      count: number;
    }[];
    const memoryTags = db
      .query('SELECT tag, COUNT(*) as count FROM memory_tags GROUP BY tag ORDER BY tag')
      .all() as { tag: string; count: number }[];
    return { spaces: spaceTags, memories: memoryTags };
  }

  function listMemoryTags(spaceName: string): string[] {
    const rows = db
      .query(
        `SELECT DISTINCT mt.tag
         FROM spaces s
         JOIN memories m ON m.space_id = s.id
         JOIN memory_tags mt ON mt.memory_id = m.id
         WHERE s.name = ?
         ORDER BY mt.tag`
      )
      .all(spaceName) as { tag: string }[];
    return rows.map(row => row.tag);
  }

  return {
    addMemoryTag,
    removeMemoryTag,
    setMemoryTags,
    listAllTags,
    listMemoryTags,
  };
}
