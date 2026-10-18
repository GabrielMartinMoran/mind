// ── UUID Primary ID Migration Tests (v7 → v8) ──

import { existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { openDatabaseWithSafeMigrations } from '../src/store/migration-safety';
import { initializeDatabase } from '../src/store/schema';

// ── This is the v7 schema, preserved here so tests can create v7 fixtures ──
// even after the production schema advances to v8+.
const V7_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS links (
    source_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT 'related',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    name, content,
    tokenize='porter unicode61'
);

CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);
CREATE INDEX IF NOT EXISTS idx_space_tags_tag ON space_tags(tag);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);

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

// WAL checkpoint helper — flushes WAL to main DB so backup/restore is clean
function walCheckpoint(db: Database): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

let counter = 0;
const cleanupPaths: string[] = [];

function tempDbPath(): string {
  const dbPath = join(tmpdir(), `mind-uuid-migration-${Date.now()}-${counter++}.db`);
  cleanupPaths.push(dbPath);
  return dbPath;
}

function cleanupDbPath(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...backupPaths(dbPath)]) {
    rmSync(path, { force: true });
  }
}

function backupPaths(dbPath: string): string[] {
  if (!existsSync(dirname(dbPath))) return [];
  const prefix = `${basename(dbPath)}.migration-backup.`;
  return readdirSync(dirname(dbPath))
    .filter(name => name.startsWith(prefix))
    .map(name => join(dirname(dbPath), name))
    .sort();
}

afterEach(() => {
  for (const dbPath of cleanupPaths.splice(0)) cleanupDbPath(dbPath);
});

// ── Helpers to create v7 fixture databases ──

function createV7Database(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(V7_SCHEMA_SQL);

  // Write schema version as 7
  const existing = db.query("SELECT 1 FROM meta WHERE key = 'schema_version'").get();
  if (!existing) {
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '7')");
  } else {
    db.run("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
  }
  return db;
}

function populateV7Fixture(db: Database): void {
  const ts = '2026-06-03 10:00:00';

  // Create spaces
  db.run(
    "INSERT INTO spaces (name, description, hidden, created_at, updated_at) VALUES ('projects/test', 'Test project', 0, ?, ?)",
    [ts, ts]
  );
  db.run(
    "INSERT INTO spaces (name, description, hidden, created_at, updated_at) VALUES ('projects/second', 'Second project', 0, ?, ?)",
    [ts, ts]
  );

  // Add space tags
  db.run("INSERT INTO space_tags (space_name, tag) VALUES ('projects/test', 'type:project')");
  db.run("INSERT INTO space_tags (space_name, tag) VALUES ('projects/second', 'type:project')");

  // Create memories (with auto-increment integer IDs 1, 2, 3, 4)
  db.run(
    "INSERT INTO memories (space_name, name, content, tier, pinned, access_count, created_at, updated_at, changed_at) VALUES ('projects/test', 'memory-one', 'Content one', 1, 1, 5, ?, ?, ?)",
    [ts, ts, ts]
  );
  db.run(
    "INSERT INTO memories (space_name, name, content, tier, pinned, access_count, created_at, updated_at, changed_at) VALUES ('projects/test', 'memory-two', 'Content two', 2, 0, 0, ?, ?, ?)",
    [ts, ts, ts]
  );
  db.run(
    "INSERT INTO memories (space_name, name, content, tier, pinned, access_count, created_at, updated_at, changed_at) VALUES ('projects/second', 'memory-three', 'Content three', 3, 0, 10, ?, ?, ?)",
    [ts, ts, ts]
  );
  db.run(
    "INSERT INTO memories (space_name, name, content, tier, pinned, access_count, created_at, updated_at, changed_at) VALUES ('projects/test', 'memory-four', 'Content four', 2, 1, 0, ?, ?, ?)",
    [ts, ts, ts]
  );

  // Add memory tags
  db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (1, 'cat:decision')");
  db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (1, 'important')");
  db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (2, 'cat:pattern')");
  db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (3, 'cat:bugfix')");
  db.run("INSERT INTO memory_tags (memory_id, tag) VALUES (4, 'cat:config')");

  // Add links
  db.run(
    "INSERT INTO links (source_id, target_id, label, created_at) VALUES (1, 2, 'depends_on', ?)",
    [ts]
  );
  db.run(
    "INSERT INTO links (source_id, target_id, label, created_at) VALUES (1, 4, 'relates_to', ?)",
    [ts]
  );
  db.run(
    "INSERT INTO links (source_id, target_id, label, created_at) VALUES (2, 3, 'caused_by', ?)",
    [ts]
  );

  // Populate FTS
  db.run('INSERT INTO memories_fts(rowid, name, content) SELECT id, name, content FROM memories');

  walCheckpoint(db);
}

// ── Tests ──

describe('UUID primary ID migration (v7 → v8)', () => {
  test('migrates a v7 database to v8 preserving all data and generating UUIDs', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    // Open with safe migrations — should detect v7 and migrate to v8
    const db = openDatabaseWithSafeMigrations(dbPath);

    // Verify schema version is now 8
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('10');

    // Verify all spaces have UUIDs
    const spaces = db
      .query('SELECT id, name, description, hidden FROM spaces ORDER BY name')
      .all() as any[];
    expect(spaces).toHaveLength(2);
    for (const s of spaces) {
      expect(s.id).toBeString();
      expect(s.id.length).toBeGreaterThanOrEqual(32); // UUID hex = 32 chars
      expect(s.id).not.toBe('');
    }
    expect(spaces[0].name).toBe('projects/second');
    expect(spaces[1].name).toBe('projects/test');

    // Verify all memories have UUIDs and correct fts_id
    const memories = db
      .query(
        'SELECT m.id, m.fts_id, m.space_id, m.name, m.content, m.tier, m.pinned, m.access_count, s.name as space_name FROM memories m JOIN spaces s ON s.id = m.space_id ORDER BY m.fts_id'
      )
      .all() as any[];
    expect(memories).toHaveLength(4);

    // Check each memory
    const mem1 = memories.find((m: any) => m.name === 'memory-one')!;
    expect(mem1.id).toBeString();
    expect(mem1.id.length).toBeGreaterThanOrEqual(32);
    expect(mem1.fts_id).toBe(1); // old id = 1
    expect(mem1.space_name).toBe('projects/test');
    expect(mem1.content).toBe('Content one');
    expect(mem1.tier).toBe(1);
    expect(mem1.pinned).toBe(1);
    expect(mem1.access_count).toBe(5);

    const mem2 = memories.find((m: any) => m.name === 'memory-two')!;
    expect(mem2.fts_id).toBe(2);
    expect(mem2.space_name).toBe('projects/test');
    expect(mem2.content).toBe('Content two');
    expect(mem2.tier).toBe(2);
    expect(mem2.pinned).toBe(0);

    const mem3 = memories.find((m: any) => m.name === 'memory-three')!;
    expect(mem3.fts_id).toBe(3);
    expect(mem3.space_name).toBe('projects/second');
    expect(mem3.content).toBe('Content three');
    expect(mem3.tier).toBe(3);
    expect(mem3.access_count).toBe(10);

    const mem4 = memories.find((m: any) => m.name === 'memory-four')!;
    expect(mem4.fts_id).toBe(4);
    expect(mem4.space_name).toBe('projects/test');
    expect(mem4.pinned).toBe(1);

    // All UUIDs should be unique
    const ids = memories.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(4);
    const spaceIds = spaces.map((s: any) => s.id);
    expect(new Set(spaceIds).size).toBe(2);

    // Verify fts_id uniqueness
    const ftsIds = memories.map((m: any) => m.fts_id);
    expect(new Set(ftsIds).size).toBe(4);

    // Verify tags preserved
    const mem1Tags = db
      .query('SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag')
      .all(mem1.id) as { tag: string }[];
    expect(mem1Tags.map(t => t.tag)).toEqual(['cat:decision', 'important']);

    const mem2Tags = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(mem2.id) as {
      tag: string;
    }[];
    expect(mem2Tags.map(t => t.tag)).toEqual(['cat:pattern']);

    const mem3Tags = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(mem3.id) as {
      tag: string;
    }[];
    expect(mem3Tags.map(t => t.tag)).toEqual(['cat:bugfix']);

    const mem4Tags = db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(mem4.id) as {
      tag: string;
    }[];
    expect(mem4Tags.map(t => t.tag)).toEqual(['cat:config']);

    // Verify links preserved
    const links = db
      .query(
        `SELECT l.source_id, l.target_id, l.label,
              ms.name as source_name, ss.name as source_space,
              mt.name as target_name, st.name as target_space
       FROM links l
       JOIN memories ms ON ms.id = l.source_id
       JOIN spaces ss ON ss.id = ms.space_id
       JOIN memories mt ON mt.id = l.target_id
       JOIN spaces st ON st.id = mt.space_id
       ORDER BY l.source_id, l.target_id`
      )
      .all() as any[];

    expect(links).toHaveLength(3);

    // Link: memory-one → memory-two (depends_on)
    const link1 = links.find((l: any) => l.label === 'depends_on')!;
    expect(link1.source_name).toBe('memory-one');
    expect(link1.source_space).toBe('projects/test');
    expect(link1.target_name).toBe('memory-two');
    expect(link1.target_space).toBe('projects/test');

    // Link: memory-one → memory-four (relates_to)
    const link2 = links.find((l: any) => l.label === 'relates_to')!;
    expect(link2.source_name).toBe('memory-one');
    expect(link2.target_name).toBe('memory-four');

    // Link: memory-two → memory-three (caused_by)
    const link3 = links.find((l: any) => l.label === 'caused_by')!;
    expect(link3.source_name).toBe('memory-two');
    expect(link3.source_space).toBe('projects/test');
    expect(link3.target_name).toBe('memory-three');
    expect(link3.target_space).toBe('projects/second');

    // Verify FTS search works
    const ftsResults = db
      .query(
        "SELECT m.name, m.content FROM memories_fts fts JOIN memories m ON m.fts_id = fts.rowid WHERE memories_fts MATCH 'content' ORDER BY rank"
      )
      .all() as any[];
    expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    expect(ftsResults.some((r: any) => r.name === 'memory-one')).toBe(true);

    // Verify fts_id_sequence exists and is > max(fts_id)
    const seq = db
      .query("SELECT next_value FROM fts_id_sequence WHERE entity = 'memories'")
      .get() as { next_value: number } | null;
    expect(seq).not.toBeNull();
    expect(seq!.next_value).toBe(5); // max fts_id = 4, so next = 5

    // Verify foreign keys are valid
    const fkProblems = db.query('PRAGMA foreign_key_check').all() as unknown[];
    expect(fkProblems).toHaveLength(0);

    // Verify no dangling tag references
    const danglingTags = db
      .query(
        'SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)'
      )
      .get() as { c: number };
    expect(danglingTags.c).toBe(0);

    // Verify no dangling link references
    const danglingLinksSrc = db
      .query('SELECT COUNT(*) as c FROM links WHERE source_id NOT IN (SELECT id FROM memories)')
      .get() as { c: number };
    const danglingLinksTgt = db
      .query('SELECT COUNT(*) as c FROM links WHERE target_id NOT IN (SELECT id FROM memories)')
      .get() as { c: number };
    expect(danglingLinksSrc.c).toBe(0);
    expect(danglingLinksTgt.c).toBe(0);

    // Verify no null/empty UUIDs
    const nullIds = db
      .query("SELECT COUNT(*) as c FROM memories WHERE id IS NULL OR id = ''")
      .get() as { c: number };
    expect(nullIds.c).toBe(0);
    const nullSpaceIds = db
      .query("SELECT COUNT(*) as c FROM spaces WHERE id IS NULL OR id = ''")
      .get() as { c: number };
    expect(nullSpaceIds.c).toBe(0);

    // Verify timestamps preserved
    const mem1Latest = db
      .query('SELECT created_at, updated_at, changed_at FROM memories WHERE fts_id = 1')
      .get() as any;
    expect(mem1Latest.created_at).toContain('2026-06-03');

    db.close();
  });

  test('migration produces proper UUID v4 format with dashes', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    // Verify UUID v4 format: 36 chars, 4 dashes at positions 8, 13, 18, 23
    const spaces = db.query('SELECT id FROM spaces').all() as { id: string }[];
    for (const s of spaces) {
      expect(s.id.length).toBe(36);
      // Check dashes at correct positions
      expect(s.id[8]).toBe('-');
      expect(s.id[13]).toBe('-');
      expect(s.id[18]).toBe('-');
      expect(s.id[23]).toBe('-');
      // Check version nibble (position 14 = '4')
      expect(s.id[14]).toBe('4');
      // Check variant nibble (position 19 = '8','9','a', or 'b')
      expect(['8', '9', 'a', 'b']).toContain(s.id[19]);
    }

    const memories = db.query('SELECT id FROM memories').all() as { id: string }[];
    for (const m of memories) {
      expect(m.id.length).toBe(36);
      expect(m.id[8]).toBe('-');
      expect(m.id[13]).toBe('-');
      expect(m.id[18]).toBe('-');
      expect(m.id[23]).toBe('-');
      expect(m.id[14]).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(m.id[19]);
    }

    // All UUIDs unique
    const allIds = [...spaces.map(s => s.id), ...memories.map(m => m.id)];
    expect(new Set(allIds).size).toBe(6); // 2 spaces + 4 memories

    db.close();
  });

  test('creates a migration backup before migrating v7 → v8', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    const backups = backupPaths(dbPath);
    expect(backups).toHaveLength(1);

    // Verify backup is actually a v7 database
    const backupDb = new Database(backups[0]!, { readonly: true });
    const backupVersion = backupDb
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    backupDb.close();
    expect(backupVersion.value).toBe('7');
  });

  test('restores backup when migration validation fails', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    expect(() =>
      openDatabaseWithSafeMigrations(dbPath, {
        validateDatabase: () => {
          throw new Error('forced UUID migration validation failure');
        },
      })
    ).toThrow(/restored backup.*forced UUID migration validation failure/);

    // Verify WAL/SHM cleaned up
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // Verify restored DB is still v7 with data intact
    const restoredDb = new Database(dbPath, { readonly: true });
    const version = restoredDb
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe('7');

    const memories = restoredDb
      .query('SELECT name, content FROM memories ORDER BY id')
      .all() as any[];
    expect(memories).toHaveLength(4);
    expect(memories[0].name).toBe('memory-one');
    expect(memories[0].content).toBe('Content one');
    restoredDb.close();
  });

  test('fresh v8 database initializes with correct schema', () => {
    const dbPath = tempDbPath();
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);

    // Verify schema version
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('10');

    // Verify memory table has UUID id and fts_id columns
    const tableInfo = db.query('PRAGMA table_info(memories)').all() as any[];
    const columns = tableInfo.map((r: any) => r.name);
    expect(columns).toContain('id');
    expect(columns).toContain('fts_id');
    expect(columns).toContain('space_id');
    expect(columns).not.toContain('space_name'); // old column removed

    // Verify spaces table has UUID id
    const spaceInfo = db.query('PRAGMA table_info(spaces)').all() as any[];
    const spaceColumns = spaceInfo.map((r: any) => r.name);
    expect(spaceColumns).toContain('id');
    expect(spaceColumns).toContain('name');

    // Verify fts_id_sequence exists with initial value
    const seq = db
      .query("SELECT next_value FROM fts_id_sequence WHERE entity = 'memories'")
      .get() as { next_value: number } | null;
    expect(seq).not.toBeNull();
    expect(seq!.next_value).toBe(1); // no memories yet

    // Verify FTS table exists
    const ftsCheck = db.query('SELECT 1 FROM memories_fts LIMIT 0').get();
    expect(ftsCheck).toBeDefined();

    // Verify indexes exist
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_memories%'")
      .all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_memories_space_id');
    expect(indexNames).toContain('idx_memories_fts_id');
    expect(indexNames).toContain('idx_memories_tier');
    expect(indexNames).toContain('idx_memories_changed_at');

    db.close();
  });

  test('fts_id_sequence initializes correctly after migration from populated v7', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    const seq = db
      .query("SELECT next_value FROM fts_id_sequence WHERE entity = 'memories'")
      .get() as { next_value: number };
    // 4 memories inserted, max fts_id = 4, next should be 5
    expect(seq.next_value).toBe(5);

    // Verify fts_id uniqueness
    const dupFtsIds = db
      .query('SELECT fts_id, COUNT(*) as c FROM memories GROUP BY fts_id HAVING c > 1')
      .all() as any[];
    expect(dupFtsIds).toHaveLength(0);

    db.close();
  });

  test('migration preserves all tier and pinned states', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    const tiers = db
      .query('SELECT name, tier, pinned FROM memories ORDER BY fts_id')
      .all() as any[];
    expect(tiers).toHaveLength(4);
    expect(tiers[0]).toEqual({ name: 'memory-one', tier: 1, pinned: 1 });
    expect(tiers[1]).toEqual({ name: 'memory-two', tier: 2, pinned: 0 });
    expect(tiers[2]).toEqual({ name: 'memory-three', tier: 3, pinned: 0 });
    expect(tiers[3]).toEqual({ name: 'memory-four', tier: 2, pinned: 1 });

    db.close();
  });

  test('FTS search works identically before and after migration', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);

    // Search before migration
    const before = v7db
      .query(
        "SELECT m.name, m.content FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH 'content' ORDER BY rank"
      )
      .all() as any[];

    v7db.close();

    // Open with migration
    const db = openDatabaseWithSafeMigrations(dbPath);

    // Search after migration
    const after = db
      .query(
        "SELECT m.name, m.content FROM memories_fts fts JOIN memories m ON m.fts_id = fts.rowid WHERE memories_fts MATCH 'content' ORDER BY rank"
      )
      .all() as any[];

    db.close();

    // Same results
    expect(after.length).toBe(before.length);
    const beforeNames = before.map((r: any) => r.name).sort();
    const afterNames = after.map((r: any) => r.name).sort();
    expect(afterNames).toEqual(beforeNames);
  });

  test('migration preserves space_tags correctly', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    const spaceTags = db
      .query('SELECT space_name, tag FROM space_tags ORDER BY space_name, tag')
      .all() as any[];
    expect(spaceTags).toHaveLength(2);
    expect(spaceTags[0]).toEqual({ space_name: 'projects/second', tag: 'type:project' });
    expect(spaceTags[1]).toEqual({ space_name: 'projects/test', tag: 'type:project' });

    db.close();
  });

  test('logs table is unchanged after migration', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    // Add a log entry before migration
    v7db.run(
      "INSERT INTO logs (source, operation, level, timestamp) VALUES ('cli', 'test', 'info', '2026-06-03 10:00:00')"
    );
    walCheckpoint(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    const logs = db.query('SELECT source, operation, level FROM logs').all() as any[];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ source: 'cli', operation: 'test', level: 'info' });

    // Verify logs still uses INTEGER primary key
    const logInfo = db.query('PRAGMA table_info(logs)').all() as any[];
    const idCol = logInfo.find((c: any) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol.type).toContain('INTEGER');

    db.close();
  });

  test('migration preserves embedding BLOB data', () => {
    const dbPath = tempDbPath();
    const v7db = createV7Database(dbPath);
    populateV7Fixture(v7db);
    // Add embedding to memory-one
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    v7db.run('UPDATE memories SET embedding = ? WHERE name = ?', [buffer, 'memory-one']);
    walCheckpoint(v7db);
    v7db.close();

    const db = openDatabaseWithSafeMigrations(dbPath);

    const mem = db.query('SELECT embedding FROM memories WHERE fts_id = 1').get() as {
      embedding: ArrayBuffer | null;
    };
    expect(mem.embedding).not.toBeNull();
    const bytes = new Uint8Array(mem.embedding!);
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(0);
    expect(bytes[3]).toBe(3);

    db.close();
  });
});
