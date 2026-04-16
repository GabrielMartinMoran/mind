// ── Sync module types ──

export type ConflictResolution = 'db-wins' | 'file-wins' | 'latest-wins';

// ── File-based config types ──

export interface SpaceSyncConfig {
  enabled: boolean;
  conflictResolution: ConflictResolution;
}

export interface MindSyncConfig {
  version: number;
  spaces: Record<string, SpaceSyncConfig>; // key = space name like "projects/mind"
}

export interface SpaceManifest {
  space: string;
}

// ── Sync state types ──

export interface SyncState {
  isExporting: boolean;
  isImporting: boolean;
  lastError: string | null;
}

export interface ExportMemoryInput {
  id: number;
  space: string;
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
  content: string;
}

export interface ExportResult {
  exported: number;
  failed: number;
  errors: string[];
}

// ── File event types ──

export type FileEventType = 'add' | 'change' | 'unlink';

export interface FileEvent {
  type: FileEventType;
  path: string;
  timestamp: number;
}

export interface SyncLock {
  origin: 'db' | 'sync';
  timestamp: number;
  filePath?: string;
}

// ── Frontmatter ──

export interface Frontmatter {
  id: number;
  space: string;
  name: string;
  tier: number;
  pinned: boolean;
  tags: string[];
  links_to: string[];
  created_at: string;
  changed_at: string;
}
