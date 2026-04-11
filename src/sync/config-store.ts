// ── SyncConfigRepository: persistence for sync_config table ──

import type { Database } from 'bun:sqlite';

import type { SyncSpaceConfig, ConflictResolution } from './types';

export interface SyncConfigRepository {
  getConfig(spaceName: string): SyncSpaceConfig | null;
  setConfig(spaceName: string, config: Partial<SyncSpaceConfig>): void;
  deleteConfig(spaceName: string): void;
  listConfigs(): SyncSpaceConfig[];
}

function rowToConfig(row: any): SyncSpaceConfig {
  return {
    spaceName: row.space_name,
    enabled: Boolean(row.enabled),
    basePath: row.base_path,
    conflictResolution: row.conflict_resolution as ConflictResolution,
    lastExportedAt: row.last_exported_at,
    lastImportedAt: row.last_imported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSyncConfigRepository(db: Database): SyncConfigRepository {
  function getConfig(spaceName: string): SyncSpaceConfig | null {
    const row = db.query('SELECT * FROM sync_config WHERE space_name = ?').get(spaceName) as any;
    return row ? rowToConfig(row) : null;
  }

  function setConfig(spaceName: string, config: Partial<SyncSpaceConfig>): void {
    const existing = getConfig(spaceName);
    const now = new Date().toISOString();

    if (existing) {
      // Update existing
      const updates: string[] = ['updated_at = ?'];
      const values: any[] = [now];

      if (config.enabled !== undefined) {
        updates.push('enabled = ?');
        values.push(config.enabled ? 1 : 0);
      }
      if (config.basePath !== undefined) {
        updates.push('base_path = ?');
        values.push(config.basePath);
      }
      if (config.conflictResolution !== undefined) {
        updates.push('conflict_resolution = ?');
        values.push(config.conflictResolution);
      }
      if (config.lastExportedAt !== undefined) {
        updates.push('last_exported_at = ?');
        values.push(config.lastExportedAt);
      }
      if (config.lastImportedAt !== undefined) {
        updates.push('last_imported_at = ?');
        values.push(config.lastImportedAt);
      }

      values.push(spaceName);
      db.prepare(`UPDATE sync_config SET ${updates.join(', ')} WHERE space_name = ?`).run(
        ...values
      );
    } else {
      // Insert new
      db.prepare(
        `
        INSERT INTO sync_config (space_name, enabled, base_path, conflict_resolution, last_exported_at, last_imported_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        spaceName,
        config.enabled ? 1 : 0,
        config.basePath ?? '',
        config.conflictResolution ?? 'db-wins',
        config.lastExportedAt ?? null,
        config.lastImportedAt ?? null,
        now,
        now
      );
    }
  }

  function deleteConfig(spaceName: string): void {
    db.prepare('DELETE FROM sync_config WHERE space_name = ?').run(spaceName);
  }

  function listConfigs(): SyncSpaceConfig[] {
    const rows = db.query('SELECT * FROM sync_config ORDER BY space_name').all() as any[];
    return rows.map(rowToConfig);
  }

  return { getConfig, setConfig, deleteConfig, listConfigs };
}
