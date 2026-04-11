// ── Sync module types ──

export type ConflictResolution = 'db-wins' | 'file-wins' | 'latest-wins';

export interface SyncSpaceConfig {
  spaceName: string;
  enabled: boolean;
  basePath: string;
  conflictResolution: ConflictResolution;
  lastExportedAt: string | null;
  lastImportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

// ── File event types (Phase 3) ──

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
