// ── Conflict Resolution for Sync ──

import type { ConflictResolution } from './types';

export interface DBMemory {
  id: number;
  name: string;
  content: string;
  changed_at: string | null;
}

/**
 * Minimal frontmatter structure needed for conflict resolution.
 */
export interface FileFrontmatter {
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
}

export interface Conflict {
  memoryId: number;
  memoryName: string;
  space: string;
  dbMemory: DBMemory | null; // null if doesn't exist in DB
  fileFrontmatter: FileFrontmatter;
  fileContent: string;
  dbChangedAt: string | null;
  fileChangedAt: string;
}

export interface ConflictResult {
  resolution: 'use-db' | 'use-file' | 'skip';
  reason: string;
}

/**
 * Resolve a conflict between DB and file based on the resolution strategy.
 */
export function resolveConflict(conflict: Conflict, strategy: ConflictResolution): ConflictResult {
  switch (strategy) {
    case 'db-wins':
      return { resolution: 'use-db', reason: 'db-wins strategy' };

    case 'file-wins':
      return { resolution: 'use-file', reason: 'file-wins strategy' };

    case 'latest-wins': {
      const dbTime = conflict.dbChangedAt ? new Date(conflict.dbChangedAt).getTime() : 0;
      const fileTime = new Date(conflict.fileChangedAt).getTime();
      return dbTime > fileTime
        ? { resolution: 'use-db', reason: 'db is newer' }
        : { resolution: 'use-file', reason: 'file is newer' };
    }
  }
}

/**
 * Determine whether to update an existing memory based on conflict resolution strategy.
 * This is a simplified version for cases where we have direct access to both changed_at values.
 */
export function shouldUpdateMemory(
  existingChangedAt: string | null | undefined,
  fileFrontmatterChangedAt: string | null | undefined,
  strategy: ConflictResolution
): boolean {
  switch (strategy) {
    case 'db-wins':
      // DB always wins - never update from file
      return false;

    case 'file-wins':
      // File always wins - always update
      return true;

    case 'latest-wins':
      // Compare changed_at timestamps
      // If we can't compare, default to updating (file is source of truth for external changes)
      if (!existingChangedAt || !fileFrontmatterChangedAt) {
        return true;
      }
      return fileFrontmatterChangedAt > existingChangedAt;

    default:
      return false;
  }
}
