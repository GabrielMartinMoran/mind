// ── MemoryRepository: handles all memory operations (v8: UUID primary keys, fts_id, space_id FK) ──

import type { Database } from 'bun:sqlite';

import { TIER_LIMITS } from '../../config';
import { blobToVector, getEmbedding, isRagEnabled, vectorToBlob } from '../../helpers/rag';
import { normalizeTags } from '../../helpers/tags';
import type { HotMemorySummary, LegacyBrain, Memory, MemorySummary, Tier } from '../../types';
import type { LinkedMemorySummary, MemoryPatchInput } from '../mind-store';
import { FtsHelper, generateUuid, now, requireMemory } from '../shared';

import type { LinkRepository } from './link-repository';
import type { SpaceRepository } from './space-repository';
import type { TagRepository } from './tag-repository';

export interface MemoryRepository {
  addMemory(
    space: string,
    name: string,
    content: string,
    opts?: { tags?: string[]; tier?: Tier; pinned?: boolean; linksToIds?: string[] }
  ): Promise<Memory>;
  getMemory(space: string, name: string): Memory | null;
  getMemoryById(id: string): Memory | null;
  listMemories(space: string, filter?: { tier?: Tier; tag?: string }): MemorySummary[];
  getHotMemories(space: string): HotMemorySummary[];
  resolveMemoryRef(ref: string): { space: string; name: string } | null;
  updateMemory(id: string, updates: { name?: string; content?: string }): Promise<void>;
  moveMemory(
    id: string,
    updates: { space: string; name?: string; content?: string; tier?: Tier }
  ): Promise<Memory>;
  deleteMemory(id: string): void;
  deleteMemoryByName(space: string, name: string): void;
  recordAccess(id: string): void;
  getLinkedMemorySummaries(memoryId: string): {
    links_to: LinkedMemorySummary[];
    linked_by: LinkedMemorySummary[];
  };
  patchMemory(id: string, patch: MemoryPatchInput): Promise<Memory>;
  promote(id: string): void;
  demote(id: string): void;
  pin(id: string): void;
  unpin(id: string): void;
  importFromJson(brain: LegacyBrain): void;
}

function getTagsForMemory(db: Database, memoryId: string): string[] {
  const rows = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(memoryId) as {
    tag: string;
  }[];
  return rows.map(r => r.tag);
}

function rowToMemory(db: Database, row: any): Memory {
  return {
    id: row.id,
    space_name: row.space_name,
    space_id: row.space_id,
    name: row.name,
    content: row.content,
    tier: row.tier as Tier,
    pinned: row.pinned === 1,
    fts_id: row.fts_id,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    embedding: row.embedding ? blobToVector(row.embedding) : null,
    tags: getTagsForMemory(db, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    changed_at: row.changed_at,
  };
}

function nextFtsId(db: Database): number {
  const row = db
    .query("SELECT next_value FROM fts_id_sequence WHERE entity = 'memories'")
    .get() as { next_value: number } | null;
  if (!row) {
    // Initialize if missing — seed with 2 so first returned id is 1, second is 2, etc.
    db.run("INSERT OR IGNORE INTO fts_id_sequence (entity, next_value) VALUES ('memories', 2)");
    return 1;
  }
  const current = row.next_value;
  db.run("UPDATE fts_id_sequence SET next_value = next_value + 1 WHERE entity = 'memories'");
  return current;
}

function getSpaceId(db: Database, spaceName: string): string {
  const row = db.query('SELECT id FROM spaces WHERE name = ?').get(spaceName) as {
    id: string;
  } | null;
  if (!row)
    throw new Error(`Space "${spaceName}" does not exist. Create it first with space_create tool.`);
  return row.id;
}

function memoryJoinSelect(): string {
  return 'SELECT m.*, s.name as space_name FROM memories m JOIN spaces s ON s.id = m.space_id';
}

export function createMemoryRepository(
  db: Database,
  spaceRepo: SpaceRepository,
  tagRepo: TagRepository,
  linkRepo: LinkRepository,
  fts: FtsHelper
): MemoryRepository {
  // ── LRU / Capacity helpers ──

  function countTierTotal(spaceId: string, tier: number): number {
    const row = db
      .query('SELECT COUNT(*) as c FROM memories WHERE space_id = ? AND tier = ?')
      .get(spaceId, tier) as { c: number };
    return row.c;
  }

  function ensureCapacity(
    spaceId: string,
    tier: number,
    throwOnFull: boolean,
    touchChangedAt = true
  ): boolean {
    const limit = TIER_LIMITS[tier as 1 | 2];
    if (limit === undefined) return true; // T3: unlimited

    const total = countTierTotal(spaceId, tier);
    if (total < limit) return true;

    const lru = db
      .query(
        `SELECT id FROM memories
                 WHERE space_id = ? AND tier = ? AND pinned = 0
                 ORDER BY COALESCE(last_accessed_at, created_at) ASC
                 LIMIT 1`
      )
      .get(spaceId, tier) as { id: string } | null;

    if (!lru) {
      if (throwOnFull) {
        throw new Error(
          `T${tier} is full (${limit}/space) and all memories are pinned. Unpin one to make room.`
        );
      }
      return false;
    }

    const nextTier = tier + 1;
    const ts = now();
    if (touchChangedAt) {
      db.run('UPDATE memories SET tier = ?, updated_at = ?, changed_at = ? WHERE id = ?', [
        nextTier,
        ts,
        ts,
        lru.id,
      ]);
    } else {
      db.run('UPDATE memories SET tier = ?, updated_at = ? WHERE id = ?', [nextTier, ts, lru.id]);
    }
    return true;
  }

  // ── Memory operations ──

  async function addMemory(
    space: string,
    name: string,
    content: string,
    opts?: { tags?: string[]; tier?: Tier; pinned?: boolean; linksToIds?: string[] }
  ): Promise<Memory> {
    const spaceId = getSpaceId(db, space);

    if (!opts?.tags || opts.tags.length === 0) {
      throw new Error('Tags are required and cannot be empty');
    }

    const existing = db
      .query('SELECT 1 FROM memories WHERE space_id = ? AND name = ?')
      .get(spaceId, name);
    if (existing) throw new Error(`Memory "${name}" already exists in space "${space}"`);

    const tier = opts?.tier ?? 2;
    const pinned = opts?.pinned ?? false;
    const linksToIds = opts?.linksToIds ?? [];

    for (const targetId of linksToIds) {
      const target = db.query('SELECT 1 FROM memories WHERE id = ?').get(targetId);
      if (!target) {
        throw new Error(
          `Cannot add memory: linked memory id ${targetId} does not exist. Use memory_query or search to find valid IDs.`
        );
      }
    }

    const addMemoryTransaction = db.transaction(() => {
      ensureCapacity(spaceId, tier, true);

      const ts = now();
      const id = generateUuid();
      const ftsId = nextFtsId(db);

      db.run(
        `INSERT INTO memories (id, fts_id, space_id, name, content, tier, pinned, created_at, updated_at, changed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ftsId, spaceId, name, content, tier, pinned ? 1 : 0, ts, ts, ts]
      );

      fts.insert(id, ftsId, name, content);

      if (opts?.tags && opts.tags.length > 0) {
        const normalizedTags = normalizeTags(opts.tags);
        const stmt = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
        for (const tag of normalizedTags) {
          stmt.run(id, tag);
        }
      }

      if (linksToIds.length > 0) {
        const linkStmt = db.prepare(
          'INSERT OR REPLACE INTO links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)'
        );
        for (const targetId of linksToIds) {
          if (targetId === id) {
            throw new Error('Cannot add memory: add_links_to_ids cannot include self links.');
          }
          linkStmt.run(id, targetId, 'related', ts);
        }
      }

      return id;
    });

    const id = addMemoryTransaction();

    // Generate embedding if RAG is enabled
    if (isRagEnabled()) {
      const embedding = await getEmbedding(`${name} ${content}`);
      if (embedding) {
        db.run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBlob(embedding), id]);
      }
    }

    const row = db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any;
    return rowToMemory(db, row);
  }

  function getMemory(space: string, name: string): Memory | null {
    const spaceId = db.query('SELECT id FROM spaces WHERE name = ?').get(space) as {
      id: string;
    } | null;
    if (!spaceId) return null;

    const row = db
      .query(`${memoryJoinSelect()} WHERE m.space_id = ? AND m.name = ?`)
      .get(spaceId.id, name) as any;
    if (!row) return null;
    return rowToMemory(db, row);
  }

  function getMemoryById(id: string): Memory | null {
    const row = db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any;
    if (!row) return null;
    return rowToMemory(db, row);
  }

  function listMemories(space: string, filter?: { tier?: Tier; tag?: string }): MemorySummary[] {
    const spaceId = getSpaceId(db, space);

    let sql = `${memoryJoinSelect()}`;
    const joinParams: any[] = [];
    const conditions: string[] = ['m.space_id = ?'];
    const whereParams: any[] = [spaceId];

    if (filter?.tag) {
      const normalizedFilter = filter.tag.toLowerCase().trim();
      sql += ' JOIN memory_tags mt ON mt.memory_id = m.id AND mt.tag = ?';
      joinParams.push(normalizedFilter);
    }

    if (filter?.tier !== undefined) {
      conditions.push('m.tier = ?');
      whereParams.push(filter.tier);
    } else {
      conditions.push('m.tier IN (1, 2)');
    }

    sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY m.tier ASC, m.access_count DESC, m.name ASC';

    const params = [...joinParams, ...whereParams];
    const rows = db.query(sql).all(...params) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      space_name: r.space_name,
      space_id: r.space_id,
      name: r.name,
      tier: r.tier as Tier,
      pinned: r.pinned === 1,
      tags: getTagsForMemory(db, r.id),
      access_count: r.access_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
      changed_at: r.changed_at,
    }));
  }

  function getHotMemories(space: string): HotMemorySummary[] {
    const spaceRow = db.query('SELECT id FROM spaces WHERE name = ?').get(space) as {
      id: string;
    } | null;
    if (!spaceRow) return [];
    const spaceId = getSpaceId(db, space);

    const rows = db
      .query(
        `SELECT id, name, tier, pinned, updated_at
                 FROM memories
                 WHERE space_id = ? AND tier IN (1, 2)
                 ORDER BY tier ASC, name ASC`
      )
      .all(spaceId) as {
      id: string;
      name: string;
      tier: Tier;
      pinned: number;
      updated_at: string;
    }[];

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      tags: getTagsForMemory(db, r.id),
      pinned: r.pinned === 1,
      updated_at: r.updated_at,
    }));
  }

  function resolveMemoryRef(ref: string): { space: string; name: string } | null {
    const idx = ref.indexOf(':');
    if (idx <= 0) return null;
    const space = ref.slice(0, idx);
    const name = ref.slice(idx + 1);
    if (!space || !name) return null;
    return { space, name };
  }

  async function updateMemory(
    id: string,
    updates: { name?: string; content?: string }
  ): Promise<void> {
    const row = requireMemory(db, id);
    const ts = now();
    const sets: string[] = ['updated_at = ?', 'changed_at = ?'];
    const params: any[] = [ts, ts];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(updates.content);
    }

    params.push(id);
    db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);

    // Sync FTS using fts_id
    if (updates.name !== undefined || updates.content !== undefined) {
      const mem = db.query('SELECT fts_id FROM memories WHERE id = ?').get(id) as {
        fts_id: number;
      };
      fts.update(id, mem.fts_id, updates.name ?? row.name, updates.content ?? row.content);
    }

    // Regenerate embedding if RAG is enabled
    if (isRagEnabled() && (updates.name !== undefined || updates.content !== undefined)) {
      const memory = rowToMemory(
        db,
        db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any
      );
      const embedding = await getEmbedding(`${memory.name} ${memory.content}`);
      if (embedding) {
        db.run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBlob(embedding), id]);
      }
    }
  }

  async function moveMemory(
    id: string,
    updates: { space: string; name?: string; content?: string; tier?: Tier }
  ): Promise<Memory> {
    const row = requireMemory(db, id);
    const nextSpace = updates.space;
    const nextSpaceId = getSpaceId(db, nextSpace);
    const nextName = updates.name ?? row.name;
    const nextContent = updates.content ?? row.content;
    const nextTier = updates.tier ?? row.tier;

    const existing = db
      .query('SELECT id FROM memories WHERE space_id = ? AND name = ? AND id != ?')
      .get(nextSpaceId, nextName, id) as { id: string } | null;
    if (existing) {
      throw new Error(`Memory "${nextName}" already exists in space "${nextSpace}"`);
    }

    const moveTransaction = db.transaction(() => {
      const currentSpaceId = db.query('SELECT space_id FROM memories WHERE id = ?').get(id) as {
        space_id: string;
      };
      if ((nextSpaceId !== currentSpaceId.space_id || nextTier !== row.tier) && nextTier < 3) {
        ensureCapacity(nextSpaceId, nextTier, true);
      }

      const ts = now();
      db.run(
        `UPDATE memories
            SET space_id = ?, name = ?, content = ?, tier = ?, updated_at = ?, changed_at = ?
          WHERE id = ?`,
        [nextSpaceId, nextName, nextContent, nextTier, ts, ts, id]
      );

      if (nextName !== row.name || nextContent !== row.content) {
        const mem = db.query('SELECT fts_id FROM memories WHERE id = ?').get(id) as {
          fts_id: number;
        };
        fts.update(id, mem.fts_id, nextName, nextContent);
      }
    });

    moveTransaction();

    if (isRagEnabled() && (nextName !== row.name || nextContent !== row.content)) {
      const memory = rowToMemory(
        db,
        db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any
      );
      const embedding = await getEmbedding(`${memory.name} ${memory.content}`);
      if (embedding) {
        db.run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBlob(embedding), id]);
      }
    }

    return rowToMemory(db, db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any);
  }

  function deleteMemory(id: string): void {
    requireMemory(db, id);
    const ftsId = (
      db.query('SELECT fts_id FROM memories WHERE id = ?').get(id) as { fts_id: number }
    )?.fts_id;
    if (ftsId) fts.delete(id, ftsId);
    db.run('DELETE FROM memories WHERE id = ?', [id]);
  }

  function deleteMemoryByName(space: string, name: string): void {
    const mem = getMemory(space, name);
    if (!mem) throw new Error(`Memory "${name}" not found in space "${space}"`);
    fts.delete(mem.id, mem.fts_id!);
    db.run('DELETE FROM memories WHERE id = ?', [mem.id]);
  }

  function recordAccess(id: string): void {
    const row = requireMemory(db, id);
    const ts = now();

    db.run(
      'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ? WHERE id = ?',
      [ts, ts, id]
    );

    if (row.pinned || row.tier <= 1) return;

    const toTier = row.tier - 1;
    const spaceId = (
      db.query('SELECT space_id FROM memories WHERE id = ?').get(id) as { space_id: string }
    ).space_id;
    const ok = ensureCapacity(spaceId, toTier, false, false);
    if (ok) {
      db.run('UPDATE memories SET tier = ?, updated_at = ? WHERE id = ?', [toTier, ts, id]);
    }
  }

  function getLinkedMemorySummaries(memoryId: string): {
    links_to: LinkedMemorySummary[];
    linked_by: LinkedMemorySummary[];
  } {
    requireMemory(db, memoryId);

    const linksToRows = db
      .query(
        `SELECT m.id, m.name, s.name as space_name, m.changed_at, m.tier, m.pinned
                 FROM links l
                 JOIN memories m ON m.id = l.target_id
                 JOIN spaces s ON s.id = m.space_id
                 WHERE l.source_id = ?
                 ORDER BY m.changed_at DESC, m.rowid DESC`
      )
      .all(memoryId) as any[];

    const linkedByRows = db
      .query(
        `SELECT m.id, m.name, s.name as space_name, m.changed_at, m.tier, m.pinned
                 FROM links l
                 JOIN memories m ON m.id = l.source_id
                 JOIN spaces s ON s.id = m.space_id
                 WHERE l.target_id = ?
                 ORDER BY m.changed_at DESC, m.rowid DESC`
      )
      .all(memoryId) as any[];

    const toSummary = (row: any): LinkedMemorySummary => ({
      id: row.id,
      name: row.name,
      space_name: row.space_name,
      changed_at: row.changed_at,
      tier: row.tier as Tier,
      tags: getTagsForMemory(db, row.id),
      pinned: row.pinned === 1,
    });

    return {
      links_to: linksToRows.map(toSummary),
      linked_by: linkedByRows.map(toSummary),
    };
  }

  async function patchMemory(id: string, patch: MemoryPatchInput): Promise<Memory> {
    requireMemory(db, id);

    const hasAnyOperation =
      patch.name !== undefined ||
      patch.content !== undefined ||
      patch.pinned !== undefined ||
      patch.tierTransition !== undefined ||
      (patch.addTags?.length ?? 0) > 0 ||
      (patch.removeTags?.length ?? 0) > 0 ||
      (patch.addLinksToIds?.length ?? 0) > 0 ||
      (patch.removeLinksToIds?.length ?? 0) > 0;

    if (!hasAnyOperation) {
      throw new Error(
        'Provide at least one operation: name, content, pinned, tier_transition, add_tags, remove_tags, add_links_to_ids, or remove_links_to_ids.'
      );
    }

    if (patch.tierTransition === 'promote') {
      const current = requireMemory(db, id);
      if (current.tier <= 1) {
        throw new Error('Cannot promote memory: already at T1.');
      }
    }

    if (patch.tierTransition === 'demote') {
      const current = requireMemory(db, id);
      if (current.tier >= 3) {
        throw new Error('Cannot demote memory: already at the lowest tier.');
      }
    }

    for (const targetId of patch.addLinksToIds ?? []) {
      if (targetId === id) {
        throw new Error('Cannot patch memory: add_links_to_ids cannot include self links.');
      }
      const target = db.query('SELECT 1 FROM memories WHERE id = ?').get(targetId);
      if (!target) {
        throw new Error(
          `Cannot patch memory: linked memory id ${targetId} does not exist. Use memory_query or search to find valid IDs.`
        );
      }
    }

    for (const targetId of patch.removeLinksToIds ?? []) {
      if (targetId === id) {
        throw new Error('Cannot patch memory: remove_links_to_ids cannot include self links.');
      }
      const target = db.query('SELECT 1 FROM memories WHERE id = ?').get(targetId);
      if (!target) {
        throw new Error(
          `Cannot patch memory: linked memory id ${targetId} does not exist. Use memory_query or search to find valid IDs.`
        );
      }
    }

    const patchTransaction = db.transaction(() => {
      if (patch.name !== undefined || patch.content !== undefined) {
        const row = requireMemory(db, id);
        const ts = now();
        const sets: string[] = ['updated_at = ?', 'changed_at = ?'];
        const params: any[] = [ts, ts];

        if (patch.name !== undefined) {
          sets.push('name = ?');
          params.push(patch.name);
        }
        if (patch.content !== undefined) {
          sets.push('content = ?');
          params.push(patch.content);
        }

        params.push(id);
        db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
        const mem = db.query('SELECT fts_id FROM memories WHERE id = ?').get(id) as {
          fts_id: number;
        };
        fts.update(id, mem.fts_id, patch.name ?? row.name, patch.content ?? row.content);
      }

      if (patch.pinned !== undefined) {
        const ts = now();
        db.run('UPDATE memories SET pinned = ?, updated_at = ?, changed_at = ? WHERE id = ?', [
          patch.pinned ? 1 : 0,
          ts,
          ts,
          id,
        ]);
      }

      if (patch.tierTransition === 'promote') {
        promote(id);
      } else if (patch.tierTransition === 'demote') {
        demote(id);
      }

      for (const tag of patch.addTags ?? []) {
        tagRepo.addMemoryTag(id, tag);
      }

      for (const tag of patch.removeTags ?? []) {
        tagRepo.removeMemoryTag(id, tag);
      }

      if ((patch.addLinksToIds?.length ?? 0) > 0) {
        const ts = now();
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)'
        );
        for (const targetId of patch.addLinksToIds ?? []) {
          stmt.run(id, targetId, 'related', ts);
        }
      }

      for (const targetId of patch.removeLinksToIds ?? []) {
        db.run('DELETE FROM links WHERE source_id = ? AND target_id = ?', [id, targetId]);
      }
    });

    patchTransaction();

    if (isRagEnabled() && (patch.name !== undefined || patch.content !== undefined)) {
      const memory = rowToMemory(
        db,
        db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any
      );
      const embedding = await getEmbedding(`${memory.name} ${memory.content}`);
      if (embedding) {
        db.run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBlob(embedding), id]);
      }
    }

    return rowToMemory(db, db.query(`${memoryJoinSelect()} WHERE m.id = ?`).get(id) as any);
  }

  function promote(id: string): void {
    const row = requireMemory(db, id);
    if (row.tier <= 1) throw new Error('Memory is already at the highest tier');

    const toTier = row.tier - 1;
    const spaceId = (
      db.query('SELECT space_id FROM memories WHERE id = ?').get(id) as { space_id: string }
    ).space_id;
    ensureCapacity(spaceId, toTier, true, true);
    const ts = now();
    db.run('UPDATE memories SET tier = ?, updated_at = ?, changed_at = ? WHERE id = ?', [
      toTier,
      ts,
      ts,
      id,
    ]);
  }

  function demote(id: string): void {
    const row = requireMemory(db, id);
    if (row.tier >= 3) throw new Error('Memory is already at the lowest tier');
    const ts = now();
    db.run('UPDATE memories SET tier = tier + 1, updated_at = ?, changed_at = ? WHERE id = ?', [
      ts,
      ts,
      id,
    ]);
  }

  function pin(id: string): void {
    requireMemory(db, id);
    const ts = now();
    db.run('UPDATE memories SET pinned = 1, updated_at = ?, changed_at = ? WHERE id = ?', [
      ts,
      ts,
      id,
    ]);
  }

  function unpin(id: string): void {
    requireMemory(db, id);
    const ts = now();
    db.run('UPDATE memories SET pinned = 0, updated_at = ?, changed_at = ? WHERE id = ?', [
      ts,
      ts,
      id,
    ]);
  }

  function importFromJson(brain: LegacyBrain): void {
    const transaction = db.transaction(() => {
      for (const [spaceName, spaceData] of Object.entries(brain)) {
        let spaceId: string;
        const existing = db.query('SELECT id FROM spaces WHERE name = ?').get(spaceName) as {
          id: string;
        } | null;
        if (!existing) {
          const ts = now();
          spaceId = generateUuid();
          db.run(
            'INSERT INTO spaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            [spaceId, spaceName, spaceData.description, ts, ts]
          );
        } else {
          spaceId = existing.id;
        }

        for (const memory of spaceData.memories) {
          const memName = memory.name || '(unnamed)';
          const existingMem = db
            .query('SELECT 1 FROM memories WHERE space_id = ? AND name = ?')
            .get(spaceId, memName);
          if (!existingMem) {
            const ts = now();
            const id = generateUuid();
            const ftsId = nextFtsId(db);
            db.run(
              `INSERT INTO memories (id, fts_id, space_id, name, content, tier, created_at, updated_at, changed_at)
                             VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?)`,
              [id, ftsId, spaceId, memName, memory.description ?? '', ts, ts, ts]
            );
            fts.insert(id, ftsId, memName, memory.description ?? '');
          }
        }
      }
    });

    transaction();
  }

  return {
    addMemory,
    getMemory,
    getMemoryById,
    listMemories,
    getHotMemories,
    resolveMemoryRef,
    updateMemory,
    moveMemory,
    deleteMemory,
    deleteMemoryByName,
    recordAccess,
    getLinkedMemorySummaries,
    patchMemory,
    promote,
    demote,
    pin,
    unpin,
    importFromJson,
  };
}
