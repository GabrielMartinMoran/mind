// ── FileSyncService: exports memories from DB to filesystem ──

import {
  mkdirSync as _mkdirSync,
  writeFileSync,
  existsSync as _existsSync,
  readFileSync as _readFileSync,
  readdirSync as _readdirSync,
} from 'fs';
import { join } from 'path';

import type { Link, Memory, MemorySummary } from '../types';

import { generateMarkdown } from './frontmatter';
import { ensureSpaceDir, getSpaceDir as _getSpaceDir } from './normalize';
import type { ExportResult } from './types';

/**
 * Minimal interface for store operations needed by FileSyncService.
 * This allows FileSyncService to work with any compatible implementation.
 */
export interface SyncStore {
  listMemories(space: string, filter?: any): MemorySummary[];
  getMemoryById(id: number): Memory | null;
  getLinks(memoryId: number): Link[];
  queryMemories(filter?: {
    space?: string;
    tier?: number;
    limit?: number;
    offset?: number;
  }): MemorySummary[];
}

export class FileSyncService {
  constructor(private readonly store: SyncStore) {}

  /**
   * Export all memories from a space to files in the new structure:
   * .mind/spaces/<hash>/memory-1.md, memory-2.md, ...
   *
   * Creates the space directory and manifest.json if they don't exist.
   * Exports ALL tiers (T1+T2+T3) for a complete snapshot.
   */
  async exportSpaceToFiles(space: string, basePath: string): Promise<ExportResult> {
    const result: ExportResult = { exported: 0, failed: 0, errors: [] };

    // Ensure the space directory exists with manifest
    let spaceDir: string;
    try {
      spaceDir = ensureSpaceDir(basePath, space);
    } catch (err) {
      result.failed++;
      result.errors.push(`Failed to create space directory: ${err}`);
      return result;
    }

    // Export ALL memories in the space (all tiers) via paginated queryMemories
    // queryMemories defaults to limit:25, so we paginate to get all memories
    const BATCH_SIZE = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const memories = this.store.queryMemories({ space, limit: BATCH_SIZE, offset });

      if (memories.length === 0) {
        break;
      }

      for (const memorySummary of memories) {
        try {
          const memory = this.store.getMemoryById(memorySummary.id);
          if (!memory) {
            result.failed++;
            result.errors.push(`Memory ${memorySummary.name} not found`);
            continue;
          }

          // Get links for this memory
          const links = this.store.getLinks(memory.id);
          const links_to = this.buildLinksTo(memory.id, links, space);

          // Generate file content
          const frontmatterData = {
            id: memory.id,
            space: memory.space_name,
            name: memory.name,
            tier: memory.tier,
            pinned: memory.pinned,
            tags: memory.tags,
            links_to,
            created_at: memory.created_at,
            changed_at: memory.changed_at,
          };

          const markdown = generateMarkdown(frontmatterData, memory.content);
          const filePath = join(spaceDir, `${this.sanitizeFilename(memory.name)}.md`);

          writeFileSync(filePath, markdown, 'utf-8');
          result.exported++;
        } catch (err) {
          result.failed++;
          result.errors.push(`Failed to export ${memorySummary.name}: ${err}`);
        }
      }

      offset += memories.length;
      hasMore = memories.length === BATCH_SIZE;
    }

    return result;
  }

  /**
   * Build links_to array from memory links.
   * Uses space:name format for cross-space links, bare name for same-space.
   */
  private buildLinksTo(memoryId: number, links: Link[], _defaultSpace: string): string[] {
    return links
      .filter(link => link.source_id === memoryId)
      .map(link => {
        if (link.source_space === link.target_space) {
          // Same space - use bare name
          return link.target_name;
        }
        // Cross-space - use space:name format
        return `${link.target_space}:${link.target_name}`;
      });
  }

  /**
   * Sanitize filename to be safe for filesystem.
   */
  private sanitizeFilename(name: string): string {
    const sanitized = name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return sanitized || 'unnamed';
  }
}
