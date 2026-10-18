// ── SQLite schema and migrations for Mind v10 ──
//
// v10 is the FINAL consolidated schema. The intermediate dev-only schemas v10
// (with a per-document search-term dictionary) and v11 (dictionary retired)
// were never published; the last published schema was v9. v10 here is
// functionally identical to the never-published dev v11: trigram index
// `tokenize='trigram remove_diacritics 1'`, `content=''`, `contentless_delete=1`;
// NO `search_terms` / `memory_terms` dictionary tables; fuzzy P-A; contentless
// recovery via `delete-all` + repopulate.

export const SCHEMA_VERSION = 10;

// Core table creation only — no indexes that reference columns not present in earlier versions
export const SCHEMA_SQL = `
-- Version tracking
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Spaces: UUID primary key + name as public unique key
CREATE TABLE IF NOT EXISTS spaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
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

-- Memories: UUID id + fts_id integer for FTS5 + space_id FK
CREATE TABLE IF NOT EXISTS memories (
    id               TEXT PRIMARY KEY,
    fts_id           INTEGER NOT NULL UNIQUE,
    space_id         TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
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
    UNIQUE(space_id, name)
);

-- Memory tags: reference UUID memory id
CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
);

-- Links: reference UUID memory ids
CREATE TABLE IF NOT EXISTS links (
    source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);

-- Full-text search (standalone, synced manually — bun:sqlite has a bug with content-sync triggers)
-- rowid is linked to memories.fts_id (not the UUID primary key)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    name, content,
    tokenize='porter unicode61'
);

-- Trigram substring index (schema v10): standalone, synced manually like
-- memories_fts. remove_diacritics=1 folds accents so accented and unaccented
-- queries match both ways (R1); content='' plus contentless_delete=1 makes it a
-- contentless index with delete support (reads return NULL; 'rebuild' is
-- unsupported — recovery uses delete-all + repopulate).
-- rowid is linked to memories.fts_id (not the UUID primary key).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_trigram USING fts5(
    name, content,
    tokenize='trigram remove_diacritics 1',
    content='',
    contentless_delete=1
);

-- fts_id sequence: transactional integer assignment for FTS5 rowid
CREATE TABLE IF NOT EXISTS fts_id_sequence (
    entity     TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL
);

-- Logs table for operation auditing (unchanged from v7)
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
`;

// Indexes that reference v8+ columns — applied AFTER schema creation or migration
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_spaces_name ON spaces(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_id ON spaces(id);
CREATE INDEX IF NOT EXISTS idx_memories_space_id ON memories(space_id);
CREATE INDEX IF NOT EXISTS idx_memories_space_id_name ON memories(space_id, name);
CREATE INDEX IF NOT EXISTS idx_memories_fts_id ON memories(fts_id);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(space_id, tier);
CREATE INDEX IF NOT EXISTS idx_memories_changed_at ON memories(changed_at);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_space_tags_tag ON space_tags(tag);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp_source ON logs(timestamp, source);
CREATE INDEX IF NOT EXISTS idx_logs_operation ON logs(operation);
`;

// ── Migration: v1 → v2 ──
const MIGRATE_V1_TO_V2 = `
PRAGMA foreign_keys = OFF;
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
INSERT INTO memories_v2 SELECT * FROM memories;
DROP TABLE memories;
ALTER TABLE memories_v2 RENAME TO memories;
CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);
PRAGMA foreign_keys = ON;
UPDATE meta SET value = '2' WHERE key = 'schema_version';
`;

// ── Migration: v2 → v3 ──
const MIGRATE_V2_TO_V3 = `
ALTER TABLE memories ADD COLUMN embedding BLOB;
UPDATE meta SET value = '3' WHERE key = 'schema_version';
`;

// ── Migration: v3 → v4 ──
const MIGRATE_V3_TO_V4 = `
ALTER TABLE memories ADD COLUMN changed_at TEXT;
UPDATE memories SET changed_at = updated_at WHERE changed_at IS NULL;
UPDATE meta SET value = '4' WHERE key = 'schema_version';
`;

// ── Migration: v4 → v5 ──
const MIGRATE_V4_TO_V5 = `
ALTER TABLE spaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
UPDATE meta SET value = '5' WHERE key = 'schema_version';
`;

// ── Migration: v5 → v6 ──
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
const MIGRATE_V6_TO_V7 = `
PRAGMA foreign_keys = OFF;
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
INSERT INTO memories_v7 SELECT
    id, space_name, name, content,
    CASE WHEN tier = 4 THEN 3 ELSE tier END,
    pinned, access_count, last_accessed_at, embedding,
    created_at, updated_at, changed_at
FROM memories;
DROP TABLE memories;
ALTER TABLE memories_v7 RENAME TO memories;
CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);
PRAGMA foreign_keys = ON;
UPDATE meta SET value = '7' WHERE key = 'schema_version';
`;

// ── Migration: v7 → v8 ──
// Changes: UUID primary keys for spaces and memories, fts_id INTEGER for FTS5,
//          space_id FK instead of space_name, fts_id_sequence table
const MIGRATE_V7_TO_V8 = `
-- Step 1: disable FK enforcement during migration
PRAGMA foreign_keys = OFF;

-- ── PHASE 1: Save dependent data into temp tables using name-based lookups ──

CREATE TEMP TABLE _migrate_tags AS
SELECT m.space_name, m.name as memory_name, mt.tag
FROM memory_tags mt
JOIN memories m ON m.id = mt.memory_id;

CREATE TEMP TABLE _migrate_links AS
SELECT m_src.space_name as src_space, m_src.name as src_name,
       m_tgt.space_name as tgt_space, m_tgt.name as tgt_name,
       l.label
FROM links l
JOIN memories m_src ON m_src.id = l.source_id
JOIN memories m_tgt ON m_tgt.id = l.target_id;

-- ── PHASE 2: Add UUIDs to spaces, create unique index for FK references ──

ALTER TABLE spaces ADD COLUMN id TEXT;
UPDATE spaces SET id = lower(
      hex(randomblob(4)) || '-' ||
      substr(hex(randomblob(2)), 1, 4) || '-4' ||
      substr(hex(randomblob(2)), 2, 3) || '-' ||
      substr('89ab', (abs(random()) % 4) + 1, 1) ||
      substr(hex(randomblob(2)), 2, 3) || '-' ||
      hex(randomblob(6))
    );
-- Unique index on spaces.id required for FK references from memories_v8
CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_id ON spaces(id);

-- ── PHASE 3: Create new memories_v8, copy data with UUIDs ──

CREATE TABLE memories_v8 (
    id               TEXT PRIMARY KEY,
    fts_id           INTEGER NOT NULL UNIQUE,
    space_id         TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
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
    UNIQUE(space_id, name)
);

INSERT INTO memories_v8 (id, fts_id, space_id, name, content, tier, pinned, access_count, last_accessed_at, embedding, created_at, updated_at, changed_at)
SELECT
    lower(
      hex(randomblob(4)) || '-' ||
      substr(hex(randomblob(2)), 1, 4) || '-4' ||
      substr(hex(randomblob(2)), 2, 3) || '-' ||
      substr('89ab', (abs(random()) % 4) + 1, 1) ||
      substr(hex(randomblob(2)), 2, 3) || '-' ||
      hex(randomblob(6))
    ) as id,
    m.id as fts_id,
    s.id as space_id,
    m.name,
    m.content,
    m.tier,
    m.pinned,
    m.access_count,
    m.last_accessed_at,
    m.embedding,
    m.created_at,
    m.updated_at,
    m.changed_at
FROM memories m
JOIN spaces s ON s.name = m.space_name;

-- ── PHASE 4: Drop old memories, rename, create indexes ──

DROP TABLE memories;
ALTER TABLE memories_v8 RENAME TO memories;

CREATE INDEX IF NOT EXISTS idx_memories_space_id ON memories(space_id);
CREATE INDEX IF NOT EXISTS idx_memories_space_id_name ON memories(space_id, name);
CREATE INDEX IF NOT EXISTS idx_memories_fts_id ON memories(fts_id);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(space_id, tier);
CREATE INDEX IF NOT EXISTS idx_memories_changed_at ON memories(changed_at);

-- ── PHASE 5: Migrate tags using UUID lookups ──

DROP TABLE memory_tags;
CREATE TABLE memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
);

INSERT INTO memory_tags (memory_id, tag)
SELECT m.id, _t.tag
FROM _migrate_tags _t
JOIN spaces s ON s.name = _t.space_name
JOIN memories m ON m.space_id = s.id AND m.name = _t.memory_name;

DROP TABLE _migrate_tags;

-- ── PHASE 6: Migrate links using UUID lookups ──

DROP TABLE links;
CREATE TABLE links (
    source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);

INSERT INTO links (source_id, target_id, label)
SELECT m_src.id, m_tgt.id, _l.label
FROM _migrate_links _l
JOIN spaces s_src ON s_src.name = _l.src_space
JOIN memories m_src ON m_src.space_id = s_src.id AND m_src.name = _l.src_name
JOIN spaces s_tgt ON s_tgt.name = _l.tgt_space
JOIN memories m_tgt ON m_tgt.space_id = s_tgt.id AND m_tgt.name = _l.tgt_name;

DROP TABLE _migrate_links;

-- ── PHASE 7: Rebuild FTS with fts_id as rowid ──

DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(name, content, tokenize='porter unicode61');

INSERT INTO memories_fts(rowid, name, content)
SELECT fts_id, name, content FROM memories;

-- ── PHASE 8: Remove now-obsolete v7 indexes ──

DROP INDEX IF EXISTS idx_memories_space;
DROP INDEX IF EXISTS idx_memories_space_tier;

-- ── PHASE 9: Create fts_id_sequence ──

CREATE TABLE IF NOT EXISTS fts_id_sequence (
    entity     TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL
);
INSERT OR REPLACE INTO fts_id_sequence (entity, next_value)
VALUES ('memories', (SELECT COALESCE(MAX(fts_id), 0) + 1 FROM memories));

-- ── PHASE 10: Re-enable FKs and bump schema version ──

PRAGMA foreign_keys = ON;
UPDATE meta SET value = '8' WHERE key = 'schema_version';
`;

// ── Migration: v8 → v9 ──
// Adds the standalone trigram FTS index for substring / typo tolerance and
// populates it from existing memories. Synced manually like memories_fts.
const MIGRATE_V8_TO_V9 = `
DELETE FROM memories_fts_trigram;
INSERT INTO memories_fts_trigram(rowid, name, content)
SELECT fts_id, name, content FROM memories;
UPDATE meta SET value = '9' WHERE key = 'schema_version';
`;

// ── Migration: v9 → v10 (FINAL schema) ──
// Builds the definitive v10 state directly from the published v9 schema:
// DROP the old trigram index, CREATE it with `remove_diacritics 1` (R1) and
// `content='', contentless_delete=1` (trigram size), repopulate it from
// `memories`, and bump the version. There is NO dictionary: the dev-only
// `search_terms` / `memory_terms` tables were never published, so this
// migration never creates or drops them.
const MIGRATE_V9_TO_V10 = `
DROP TABLE memories_fts_trigram;
CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(
    name, content,
    tokenize='trigram remove_diacritics 1',
    content='',
    contentless_delete=1
);
INSERT INTO memories_fts_trigram(rowid, name, content)
SELECT fts_id, name, content FROM memories;
UPDATE meta SET value = '10' WHERE key = 'schema_version';
`;

// ── Migration: v10 → v11 (REMOVED) ──
// The dev-only v11 schema retired a per-document dictionary that was prototyped
// in an equally dev-only v10. Neither was ever published, so the final v10
// (SCHEMA_SQL + MIGRATE_V9_TO_V10) already IS the functional state of that dev
// v11. The dictionary migration and its guard were deleted rather than kept as
// permanent compatibility. Dev databases stamped `schema_version = 11` are
// normalized to 10 with `scripts/normalize-dev-db.ts` (see that script).

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
    // Initialize fts_id_sequence for fresh databases
    db.run("INSERT OR IGNORE INTO fts_id_sequence (entity, next_value) VALUES ('memories', 1)");
    // Apply indexes after fresh table creation
    db.exec(SCHEMA_INDEXES);
    return;
  }

  const currentVersion = parseInt(meta.value, 10);

  if (currentVersion < 2) {
    db.exec(MIGRATE_V1_TO_V2);
  }

  if (currentVersion < 3) {
    db.exec(MIGRATE_V2_TO_V3);
  }

  if (currentVersion < 4) {
    db.exec(MIGRATE_V3_TO_V4);
  }

  if (currentVersion < 5) {
    db.exec(MIGRATE_V4_TO_V5);
  }

  if (currentVersion < 6) {
    db.exec(MIGRATE_V5_TO_V6);
  }

  if (currentVersion < 7) {
    db.exec(MIGRATE_V6_TO_V7);
  }

  if (currentVersion < 8) {
    db.exec(MIGRATE_V7_TO_V8);
  }

  if (currentVersion < 9) {
    db.exec(MIGRATE_V8_TO_V9);
  }

  if (currentVersion < 10) {
    db.exec(MIGRATE_V9_TO_V10);
  }

  // Always apply indexes after migrations — for v8+, the migration creates
  // the needed indexes, but SCHEMA_INDEXES uses IF NOT EXISTS so it's a no-op.
  db.exec(SCHEMA_INDEXES);
}
