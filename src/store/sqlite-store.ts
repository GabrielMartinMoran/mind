// ── SQLite implementation of MindStore ──
// Refactored to use Repository Factory pattern internally while maintaining MindStore interface

import { existsSync, statSync, copyFileSync, unlinkSync } from 'fs';

import { Database } from 'bun:sqlite';

import { isRagEnabled } from '../helpers/rag';
import { FileSyncService } from '../sync';
import type { Tier, StatusResult } from '../types';

import type { MindStore } from './mind-store';
import {
  createTagRepository,
  createLinkRepository,
  createLogRepository,
  createSpaceRepository,
  createMemoryRepository,
  createSearchRepository,
  subscribeToLogs,
  unsubscribeFromLogs,
} from './repositories';
import { initializeDatabase } from './schema';
import { FtsHelper } from './shared';

/**
 * Run a quick integrity check and attempt FTS rebuild if the database is corrupted.
 * Returns true if the database is usable, false if unrecoverable.
 */
function ensureIntegrity(db: Database, dbPath: string): boolean {
  try {
    const result = db.query('PRAGMA quick_check(1)').get() as { quick_check: string } | null;
    if (result?.quick_check === 'ok') return true;
  } catch {
    // quick_check itself failed — DB is definitely corrupted
  }

  // Attempt FTS rebuild first (most common corruption source with manual FTS sync)
  try {
    console.error('[mind] Database corruption detected, attempting FTS rebuild...');
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    const recheck = db.query('PRAGMA quick_check(1)').get() as { quick_check: string } | null;
    if (recheck?.quick_check === 'ok') {
      console.error('[mind] FTS rebuild succeeded, database recovered.');
      return true;
    }
  } catch {
    // FTS rebuild failed too
  }

  // Last resort: backup corrupt file and start fresh
  const backupPath = `${dbPath}.corrupt.${Date.now()}`;
  try {
    console.error(
      `[mind] FTS rebuild failed. Backing up corrupt DB to ${backupPath} and starting fresh.`
    );
    db.close();
    copyFileSync(dbPath, backupPath);
    // Remove WAL/SHM files too
    for (const suffix of ['-wal', '-shm']) {
      const walPath = `${dbPath}${suffix}`;
      if (existsSync(walPath)) unlinkSync(walPath);
    }
    unlinkSync(dbPath);
  } catch (e) {
    console.error(`[mind] Failed to backup corrupt database: ${e}`);
  }
  return false;
}

export function createSqliteStore(dbPath: string): MindStore {
  let db = new Database(dbPath, { create: true });
  initializeDatabase(db);

  if (!ensureIntegrity(db, dbPath)) {
    // Corrupt DB was backed up and removed — create fresh
    db = new Database(dbPath, { create: true });
    initializeDatabase(db);
  }

  // ── Create shared helpers ──
  const fts = new FtsHelper(db);

  // ── Create repositories in dependency order ──
  // Stateless first: Tag → Link → Log
  const tagRepo = createTagRepository(db);
  const linkRepo = createLinkRepository(db);
  const logRepo = createLogRepository(db);

  // Stateful: Space (depends on FtsHelper)
  const spaceRepo = createSpaceRepository(db, fts);

  // Stateful: Memory (depends on Space, Tag, Link, FtsHelper)
  const memoryRepo = createMemoryRepository(db, spaceRepo, tagRepo, linkRepo, fts);

  // Search (depends on Memory, Tag)
  const searchRepo = createSearchRepository(db, memoryRepo, tagRepo);

  // Sync: create a partial store-like object for FileSyncService
  const syncStore = {
    listMemories: (space: string, filter?: any) => memoryRepo.listMemories(space, filter),
    getMemoryById: (id: number) => memoryRepo.getMemoryById(id),
    getLinks: (memoryId: number) => linkRepo.getLinks(memoryId),
    queryMemories: (filter?: any) => searchRepo.queryMemories(filter),
  };
  const fileSyncService = new FileSyncService(syncStore);

  // ── Build MindStore interface (flat object for backward compatibility) ──

  function getStatus(space?: string): StatusResult {
    const spaceFilter = space ? 'WHERE space_name = ?' : '';
    const spaceParams: any[] = space ? [space] : [];

    const total_spaces = space
      ? 1
      : (db.query('SELECT COUNT(*) as c FROM spaces').get() as { c: number }).c;

    const total_memories = (
      db.query(`SELECT COUNT(*) as c FROM memories ${spaceFilter}`).get(...spaceParams) as {
        c: number;
      }
    ).c;

    const tierRows = db
      .query(
        `SELECT tier, COUNT(*) as count, SUM(pinned) as pinned
                 FROM memories ${spaceFilter}
                 GROUP BY tier
                 ORDER BY tier`
      )
      .all(...spaceParams) as { tier: number; count: number; pinned: number }[];

    // Always return all 3 tiers
    const allTiers: Tier[] = [1, 2, 3];
    const by_tier = allTiers.map(t => {
      const row = tierRows.find(r => r.tier === t);
      return { tier: t, count: row?.count ?? 0, pinned: row?.pinned ?? 0 };
    });

    let db_size_bytes = 0;
    try {
      db_size_bytes = statSync(dbPath).size;
    } catch {
      db_size_bytes = 0;
    }

    // Count memories with embeddings
    let embedSql = 'SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL';
    const embedParams: any[] = [];
    if (space) {
      embedSql += ' AND space_name = ?';
      embedParams.push(space);
    }
    const embeddings_indexed = (db.query(embedSql).get(...embedParams) as { c: number }).c;

    return {
      db_path: dbPath,
      db_size_bytes,
      total_spaces,
      total_memories,
      by_tier,
      rag_enabled: isRagEnabled(),
      embeddings_indexed,
    };
  }

  function close(): void {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Best-effort WAL checkpoint before close
    }
    db.close();
  }

  return {
    // Spaces
    createSpace: (name, description, tags) => spaceRepo.createSpace(name, description, tags),
    getSpace: name => spaceRepo.getSpace(name),
    listSpaces: filter => spaceRepo.listSpaces(filter),
    updateSpace: (name, updates) => spaceRepo.updateSpace(name, updates),
    deleteSpace: name => spaceRepo.deleteSpace(name),
    renameSpace: (oldName, newName) => spaceRepo.renameSpace(oldName, newName),
    addSpaceTag: (space, tag) => spaceRepo.addSpaceTag(space, tag),
    removeSpaceTag: (space, tag) => spaceRepo.removeSpaceTag(space, tag),

    // Memories
    addMemory: (space, name, content, opts) => memoryRepo.addMemory(space, name, content, opts),
    getMemory: (space, name) => memoryRepo.getMemory(space, name),
    getMemoryById: id => memoryRepo.getMemoryById(id),
    listMemories: (space, filter) => memoryRepo.listMemories(space, filter),
    getHotMemories: space => memoryRepo.getHotMemories(space),
    resolveMemoryRef: ref => memoryRepo.resolveMemoryRef(ref),
    updateMemory: (id, updates) => memoryRepo.updateMemory(id, updates),
    deleteMemory: id => memoryRepo.deleteMemory(id),
    deleteMemoryByName: (space, name) => memoryRepo.deleteMemoryByName(space, name),
    recordAccess: id => memoryRepo.recordAccess(id),
    getLinkedMemorySummaries: id => memoryRepo.getLinkedMemorySummaries(id),
    patchMemory: (id, patch) => memoryRepo.patchMemory(id, patch),

    // Tags (delegated to TagRepository)
    addMemoryTag: (id, tag) => tagRepo.addMemoryTag(id, tag),
    removeMemoryTag: (id, tag) => tagRepo.removeMemoryTag(id, tag),
    setMemoryTags: (id, tags) => tagRepo.setMemoryTags(id, tags),
    listAllTags: () => tagRepo.listAllTags(),

    // Tiers
    promote: id => memoryRepo.promote(id),
    demote: id => memoryRepo.demote(id),
    pin: id => memoryRepo.pin(id),
    unpin: id => memoryRepo.unpin(id),

    // Links (delegated to LinkRepository)
    link: (sourceId, targetId, label) => linkRepo.linkMemories(sourceId, targetId, label),
    unlink: (sourceId, targetId) => linkRepo.unlinkMemories(sourceId, targetId),
    getLinks: memoryId => linkRepo.getLinks(memoryId),

    // Search (delegated to SearchRepository)
    search: (query, filter) => searchRepo.searchMemories(query, filter),
    searchFallback: (query, filter) => searchRepo.searchFallback(query, filter),
    queryMemories: filter => searchRepo.queryMemories(filter),
    queryMemoriesCount: filter => searchRepo.queryMemoriesCount(filter),
    getSpaceGraph: (space, opts) => searchRepo.getSpaceGraph(space, opts),

    // Status
    getStatus,

    // Migration
    importFromJson: brain => memoryRepo.importFromJson(brain),

    // Logs (delegated to LogRepository)
    addLog: entry => logRepo.addLog(entry),
    queryLogs: filter => logRepo.queryLogs(filter),
    cleanupOldLogs: retentionMinutes => logRepo.cleanupOldLogs(retentionMinutes),
    clearAllLogs: () => logRepo.clearAllLogs(),
    subscribeToLogs,
    unsubscribeFromLogs,

    // Sync operations (Phase 1: export only)
    exportSpaceToFiles: (space, basePath) => fileSyncService.exportSpaceToFiles(space, basePath),

    // Lifecycle
    close,
  };
}
