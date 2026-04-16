// ── AutoSyncService: manages file watchers and imports external changes to DB ──

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

import type { MindStore } from '../store/mind-store';
import type { Tier } from '../types';

import { loadConfig, saveConfig as _saveConfig } from './config-file';
import { shouldUpdateMemory } from './conflict-resolver';
import { FileWatcher } from './file-watcher';
import { parseFrontmatter } from './frontmatter';
import { getSyncBasePath, getSpaceDir } from './normalize';
import type { FileEvent, SpaceSyncConfig } from './types';

const SYNC_METADATA_DIR = '.mind-sync';
const LOCK_FILE = '.syncing';
const LOCK_TTL_MS = 5000; // 5 seconds — enough for one export cycle

interface SyncLock {
  origin: 'db' | 'sync';
  timestamp: number;
  filePath?: string;
}

interface ImportResult {
  action: 'imported' | 'updated' | 'skipped' | 'deleted' | 'failed';
  memoryName?: string;
  error?: string;
}

/**
 * Get the sync config for a specific space from the file-based config.
 * Returns null if sync is not enabled for the space.
 */
function getSpaceSyncConfig(projectRoot: string, space: string): SpaceSyncConfig | null {
  const basePath = getSyncBasePath(projectRoot);
  const config = loadConfig(basePath);
  if (!config) {
    return null;
  }
  const spaceConfig = config.spaces[space];
  if (!spaceConfig || !spaceConfig.enabled) {
    return null;
  }
  return spaceConfig;
}

/**
 * Get all enabled sync configs from the file-based config.
 */
function getEnabledSyncConfigs(
  projectRoot: string
): Array<{ spaceName: string; config: SpaceSyncConfig; basePath: string }> {
  const basePath = getSyncBasePath(projectRoot);
  const config = loadConfig(basePath);
  if (!config) {
    return [];
  }

  return Object.entries(config.spaces)
    .filter(([, spaceConfig]) => spaceConfig.enabled)
    .map(([spaceName, spaceConfig]) => ({
      spaceName,
      config: spaceConfig,
      basePath: getSpaceDir(basePath, spaceName),
    }));
}

/**
 * AutoSyncService manages file watchers per space, handles the import pipeline
 * (FS → DB), and implements loop prevention via lock files.
 */
export class AutoSyncService {
  private watchers: Map<string, FileWatcher> = new Map();
  private inProgressFiles: Set<string> = new Set(); // loop prevention: files being imported right now
  private projectRoot: string;

  constructor(
    private readonly store: MindStore,
    projectRoot?: string
  ) {
    // If projectRoot not provided, use cwd
    this.projectRoot = projectRoot ?? process.cwd();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start watching a space's sync directory for external file changes.
   */
  async startWatching(space: string): Promise<void> {
    if (this.watchers.has(space)) {
      return; // already watching
    }

    const spaceConfig = getSpaceSyncConfig(this.projectRoot, space);
    if (!spaceConfig) {
      throw new Error(`Sync is not enabled for space "${space}". Run "sync enable" first.`);
    }

    const basePath = getSpaceDir(getSyncBasePath(this.projectRoot), space);
    if (!existsSync(basePath)) {
      throw new Error(`Sync directory does not exist: ${basePath}`);
    }

    const watcher = new FileWatcher(basePath, async event => {
      await this.handleFileEvent(event, space);
    });

    watcher.start();
    this.watchers.set(space, watcher);
  }

  /**
   * Stop watching a space.
   */
  async stopWatching(space: string): Promise<void> {
    const watcher = this.watchers.get(space);
    if (watcher) {
      watcher.stop();
      this.watchers.delete(space);
    }
  }

  /**
   * Stop all watchers.
   */
  async stopAll(): Promise<void> {
    for (const [space] of this.watchers) {
      await this.stopWatching(space);
    }
  }

  // ── Event handling ─────────────────────────────────────────────────────────

  /**
   * Process a single file event from the watcher.
   */
  async handleFileEvent(event: FileEvent, space: string): Promise<void> {
    // Loop prevention: skip if this file is currently being synced (exported)
    if (this.inProgressFiles.has(event.path)) {
      return;
    }

    // Loop prevention: check if this file was recently written by our own export
    if (this.isFromSync(event.path)) {
      return;
    }

    switch (event.type) {
      case 'add':
      case 'change':
        await this.importFile(event.path, space);
        break;
      case 'unlink':
        // File was deleted externally — we don't auto-delete from DB
        // The user might have accidentally deleted; they can recover from git
        break;
    }
  }

  /**
   * Import a single markdown file into the DB.
   * Handles add (new memory) and change (update existing).
   */
  async importFile(filePath: string, space: string): Promise<ImportResult> {
    // Mark file as in-progress (loop prevention)
    this.inProgressFiles.add(filePath);

    try {
      const spaceConfig = getSpaceSyncConfig(this.projectRoot, space);
      if (!spaceConfig) {
        return { action: 'failed', error: 'No sync config' };
      }

      const content = await Bun.file(filePath).text();
      let frontmatter: ReturnType<typeof parseFrontmatter>['frontmatter'];
      let body: string;

      try {
        ({ frontmatter, content: body } = parseFrontmatter(content));
      } catch (err) {
        return { action: 'failed', error: `Invalid frontmatter: ${err}` };
      }

      // Look up existing memory by name
      const existing = this.store.getMemory(space, frontmatter.name);

      if (existing) {
        // Decide whether to update based on conflict resolution
        const shouldUpdate = shouldUpdateMemory(
          existing.changed_at,
          frontmatter.changed_at,
          spaceConfig.conflictResolution
        );
        if (shouldUpdate) {
          await this.store.updateMemory(existing.id, { content: body });
          return { action: 'updated', memoryName: frontmatter.name };
        } else {
          return { action: 'skipped', memoryName: frontmatter.name };
        }
      } else {
        // Create new memory
        const mem = await this.store.addMemory(space, frontmatter.name, body, {
          tags: frontmatter.tags,
          tier: frontmatter.tier as Tier,
          pinned: frontmatter.pinned,
        });
        return { action: 'imported', memoryName: mem.name };
      }
    } catch (err) {
      return { action: 'failed', error: String(err) };
    } finally {
      this.inProgressFiles.delete(filePath);
    }
  }

  // ── Loop prevention ───────────────────────────────────────────────────────

  /**
   * Write a lock file before exporting DB→FS so the watcher can detect it.
   * Returns the lock path so it can be cleaned up after export.
   */
  writeSyncLock(basePath: string, filePath?: string): string {
    this.ensureMetadataDir(basePath);
    const lockPath = join(basePath, SYNC_METADATA_DIR, LOCK_FILE);
    const lock: SyncLock = {
      origin: 'db',
      timestamp: Date.now(),
      filePath,
    };
    writeFileSync(lockPath, JSON.stringify(lock), 'utf-8');
    return lockPath;
  }

  /**
   * Remove the lock file after export completes.
   */
  clearSyncLock(basePath: string): void {
    const lockPath = join(basePath, SYNC_METADATA_DIR, LOCK_FILE);
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  }

  /**
   * Remove the lock file (fire-and-forget) after export completes.
   */
  clearSyncLockAsync(basePath: string): void {
    try {
      this.clearSyncLock(basePath);
    } catch {
      // ignore
    }
  }

  /**
   * Check if a file change came from our own sync (DB→FS export).
   * Returns true if the file was recently written by us and should be skipped.
   */
  private isFromSync(filePath: string): boolean {
    const configs = getEnabledSyncConfigs(this.projectRoot);

    for (const { basePath } of configs) {
      const markerPath = join(basePath, SYNC_METADATA_DIR, LOCK_FILE);

      if (!existsSync(markerPath)) continue;

      // Check if the lock is recent
      try {
        const raw = readFileSync(markerPath, 'utf-8');
        const lock: SyncLock = JSON.parse(raw);

        // If lock was created by us (origin=db) and is recent, skip
        if (lock.origin === 'db' && Date.now() - lock.timestamp < LOCK_TTL_MS) {
          // Also check if this specific file was being exported
          if (!lock.filePath || lock.filePath === filePath) {
            return true;
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    return false;
  }

  /**
   * Ensure the .mind-sync metadata directory exists.
   */
  private ensureMetadataDir(basePath: string): void {
    const dir = join(basePath, SYNC_METADATA_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Import all markdown files from a directory into the DB.
   * Used by sync now command.
   */
  async importFromDirectory(
    space: string
  ): Promise<{ imported: number; updated: number; failed: number; errors: string[] }> {
    const result = { imported: 0, updated: 0, failed: 0, errors: [] as string[] };
    const basePath = getSpaceDir(getSyncBasePath(this.projectRoot), space);

    if (!existsSync(basePath)) {
      result.errors.push(`Directory does not exist: ${basePath}`);
      return result;
    }

    const files = readdirSync(basePath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = join(basePath, file);
      const importResult = await this.importFile(filePath, space);

      switch (importResult.action) {
        case 'imported':
          result.imported++;
          break;
        case 'updated':
          result.updated++;
          break;
        case 'failed':
          result.failed++;
          if (importResult.error) {
            result.errors.push(`${file}: ${importResult.error}`);
          }
          break;
        // skipped and deleted don't count as failures
      }
    }

    return result;
  }
}

/**
 * Start autosync watchers for all enabled spaces.
 */
export async function startAutosyncWatchers(store: MindStore, projectRoot?: string): Promise<void> {
  const autoSync = new AutoSyncService(store, projectRoot);
  const enabledSpaces = getEnabledSyncConfigs(projectRoot ?? process.cwd());

  if (enabledSpaces.length === 0) return;

  console.error(`[autosync] Starting ${enabledSpaces.length} watcher(s)...`);

  for (const { spaceName, basePath } of enabledSpaces) {
    try {
      await autoSync.startWatching(spaceName);
      console.error(`[autosync] Watching ${spaceName} → ${basePath}`);
    } catch (err) {
      console.error(`[autosync] Failed to watch ${spaceName}: ${err}`);
      // Non-fatal: continue with other spaces
    }
  }
}
