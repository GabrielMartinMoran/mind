// ── SQLite schema and migrations for Mind v7 ──

export const SCHEMA_VERSION = 7;

export const SCHEMA_SQL = `
-- Version tracking
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Spaces
CREATE TABLE IF NOT EXISTS spaces (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    hidden      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS space_tags (
    space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (space_name, tag)
);

-- Memories (tier 1=hot, 2=warm, 3=cold)
CREATE TABLE IF NOT EXISTS memories (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    space_name       TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE,
    name             TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    tier             INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
    pinned           INTEGER NOT NULL DEFAULT 0,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    embedding        BLOB,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    changed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(space_name, name)
);

CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
);

-- Links between memories
CREATE TABLE IF NOT EXISTS links (
    source_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);

-- Full-text search (standalone, synced manually — bun:sqlite has a bug with content-sync triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    name, content,
    tokenize='porter unicode61'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_space_tags_tag ON space_tags(tag);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);

-- Logs table for operation auditing
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    operation TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    input_data TEXT,
    output_data TEXT,
    error_message TEXT,
    caller_info TEXT,
    duration_ms INTEGER,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp_source ON logs(timestamp, source);
CREATE INDEX IF NOT EXISTS idx_logs_operation ON logs(operation);
`;

// ── Migration: v1 → v2 ──
// Changes: memories.tier CHECK constraint BETWEEN 1 AND 3 → BETWEEN 1 AND 4
// SQLite doesn't support ALTER COLUMN, so we use the 12-step table recreation.
const MIGRATE_V1_TO_V2 = `
-- Step 1: disable FK enforcement during migration
PRAGMA foreign_keys = OFF;

-- Step 2: recreate memories with the new CHECK constraint
CREATE TABLE memories_v2 (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    space_name       TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE,
    name             TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    tier             INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 4),
    pinned           INTEGER NOT NULL DEFAULT 0,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(space_name, name)
);

-- Step 3: copy all existing data
INSERT INTO memories_v2 SELECT * FROM memories;

-- Step 4: drop the old table (cascades its indexes)
DROP TABLE memories;

-- Step 5: rename
ALTER TABLE memories_v2 RENAME TO memories;

-- Step 6: recreate indexes
CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);

-- Step 7: re-enable FK enforcement
PRAGMA foreign_keys = ON;

-- Step 8: bump schema version
UPDATE meta SET value = '2' WHERE key = 'schema_version';
`;

// ── Migration: v2 → v3 ──
// Changes: add memories.embedding BLOB column for RAG/embeddings
const MIGRATE_V2_TO_V3 = `
ALTER TABLE memories ADD COLUMN embedding BLOB;
UPDATE meta SET value = '3' WHERE key = 'schema_version';
`;

// ── Migration: v3 → v4 ──
// Changes: add memories.changed_at column for semantic memory changes
const MIGRATE_V3_TO_V4 = `
ALTER TABLE memories ADD COLUMN changed_at TEXT;
UPDATE memories SET changed_at = updated_at WHERE changed_at IS NULL;
UPDATE meta SET value = '4' WHERE key = 'schema_version';
`;

// ── Migration: v4 → v5 ──
// Changes: add spaces.hidden column for hidden spaces (used by checkpoint system)
const MIGRATE_V4_TO_V5 = `
ALTER TABLE spaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
UPDATE meta SET value = '5' WHERE key = 'schema_version';
`;

// ── Migration: v5 → v6 ──
// Changes: add logs table for operation auditing
const MIGRATE_V5_TO_V6 = `
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    operation TEXT NOT NULL,
    level TEXT DEFAULT 'info',
    input_data TEXT,
    output_data TEXT,
    error_message TEXT,
    caller_info TEXT,
    duration_ms INTEGER,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp_source ON logs(timestamp, source);
CREATE INDEX IF NOT EXISTS idx_logs_operation ON logs(operation);
UPDATE meta SET value = '6' WHERE key = 'schema_version';
`;

// ── Migration: v6 → v7 ──
// Changes: remove T4 (frozen) tier entirely; T3 becomes unlimited; migrate all T4 → T3
const MIGRATE_V6_TO_V7 = `
-- Step 1: disable FK enforcement during migration
PRAGMA foreign_keys = OFF;

-- Step 2: recreate memories with the new CHECK constraint (T3 only, no T4)
CREATE TABLE memories_v7 (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    space_name       TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE,
    name             TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    tier             INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
    pinned           INTEGER NOT NULL DEFAULT 0,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    embedding        BLOB,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    changed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(space_name, name)
);

-- Step 3: copy all existing data (T4 → T3 via CASE expression to satisfy CHECK constraint)
INSERT INTO memories_v7 SELECT
    id, space_name, name, content,
    CASE WHEN tier = 4 THEN 3 ELSE tier END,
    pinned, access_count, last_accessed_at, embedding,
    created_at, updated_at, changed_at
FROM memories;

-- Step 4: drop the old table (cascades its indexes)
DROP TABLE memories;

-- Step 5: rename
ALTER TABLE memories_v7 RENAME TO memories;

-- Step 6: recreate indexes
CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);

-- Step 7: re-enable FK enforcement
PRAGMA foreign_keys = ON;

-- Step 8: bump schema version
UPDATE meta SET value = '7' WHERE key = 'schema_version';
`;

export function initializeDatabase(db: import('bun:sqlite').Database): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA wal_autocheckpoint = 1000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  const meta = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
    value: string;
  } | null;

  if (!meta) {
    // Brand-new database — tables were just created with the current schema
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [
      'schema_version',
      String(SCHEMA_VERSION),
    ]);
    return;
  }

  const currentVersion = parseInt(meta.value, 10);

  if (currentVersion < 2) {
    // Migrate v1 → v2
    db.exec(MIGRATE_V1_TO_V2);
  }

  if (currentVersion < 3) {
    // Migrate v2 → v3
    db.exec(MIGRATE_V2_TO_V3);
  }

  if (currentVersion < 4) {
    // Migrate v3 → v4
    db.exec(MIGRATE_V3_TO_V4);
  }

  if (currentVersion < 5) {
    // Migrate v4 → v5
    db.exec(MIGRATE_V4_TO_V5);
  }

  if (currentVersion < 6) {
    // Migrate v5 → v6
    db.exec(MIGRATE_V5_TO_V6);
  }

  if (currentVersion < 7) {
    // Migrate v6 → v7
    db.exec(MIGRATE_V6_TO_V7);
  }

  // Future migrations: add else-if blocks here for v7→v8, etc.
}
