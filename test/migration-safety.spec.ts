import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  getAutomaticMigrationBackupPaths,
  openDatabaseWithSafeMigrations,
  validateMigratedDatabase,
} from '../src/store/migration-safety';
import { SCHEMA_VERSION, initializeDatabase } from '../src/store/schema';
import { createSqliteStore } from '../src/store/sqlite-store';

let counter = 0;
const cleanupPaths: string[] = [];

function tempDbPath(): string {
  const dbPath = join(tmpdir(), `mind-migration-safety-${Date.now()}-${counter++}.db`);
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

function createCurrentDb(dbPath: string): void {
  // Create a v8 (current) database for tests that should not trigger migration
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db);
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'project', 'migration test')"
  );
  db.exec(
    "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', 'kept', 'important data', 2)"
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function createV8Database(dbPath: string): void {
  // Create a v8-compatible database (no trigram index) for migration testing
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db); // creates current tables
  db.exec('DROP TABLE memories_fts_trigram'); // simulate v8 (trigram index absent)
  db.exec("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'project', 'migration test')"
  );
  db.exec(
    "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', 'kept', 'important data', 2)"
  );
  db.exec("INSERT INTO memories_fts(rowid, name, content) VALUES (1, 'kept', 'important data')");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/**
 * Create a published-schema v9 database (old trigram DDL, no dictionary) with
 * one seeded memory, for the direct v9→v10 migration tests.
 */
function createV9Database(dbPath: string, opts: { memory: string } = { memory: 'kept' }): void {
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db); // creates the final v10 tables
  // Regress to the published v9 shape: old non-contentless trigram DDL.
  db.exec('DROP TABLE memories_fts_trigram');
  db.exec(
    "CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(name, content, tokenize='trigram')"
  );
  db.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'project', 'migration test')"
  );
  db.exec(
    "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', ?, 'important data', 2)",
    [opts.memory]
  );
  db.exec(
    `INSERT INTO memories_fts(rowid, name, content) VALUES (1, '${opts.memory}', 'important data')`
  );
  db.exec(
    `INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (1, '${opts.memory}', 'important data')`
  );
  db.exec("UPDATE fts_id_sequence SET next_value = 2 WHERE entity = 'memories'");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function createV7Database(dbPath: string): void {
  // Create a v7-compatible database for migration testing
  const v7Schema =
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    "CREATE TABLE IF NOT EXISTS spaces (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));" +
    'CREATE TABLE IF NOT EXISTS space_tags (space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (space_name, tag));' +
    "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, space_name TEXT NOT NULL REFERENCES spaces(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tier INTEGER NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3), pinned INTEGER NOT NULL DEFAULT 0, access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, embedding BLOB, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), changed_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(space_name, name));" +
    'CREATE TABLE IF NOT EXISTS memory_tags (memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (memory_id, tag));' +
    "CREATE TABLE IF NOT EXISTS links (source_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT 'related', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (source_id, target_id), CHECK (source_id != target_id));" +
    "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(name, content, tokenize='porter unicode61');" +
    'CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_name);' +
    'CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);' +
    'CREATE INDEX IF NOT EXISTS idx_memories_space_tier ON memories(space_name, tier);' +
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, operation TEXT NOT NULL, level TEXT DEFAULT 'info', input_data TEXT, output_data TEXT, error_message TEXT, caller_info TEXT, duration_ms INTEGER, timestamp TEXT NOT NULL DEFAULT (datetime('now')));" +
    'CREATE INDEX IF NOT EXISTS idx_logs_timestamp_source ON logs(timestamp, source);' +
    'CREATE INDEX IF NOT EXISTS idx_logs_operation ON logs(operation);';
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(v7Schema);
  db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '7')");
  db.exec("INSERT INTO spaces (name, description) VALUES ('project', 'migration test')");
  db.exec(
    "INSERT INTO memories (space_name, name, content, tier) VALUES ('project', 'kept', 'important data', 2)"
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function markDbOutdated(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('UPDATE meta SET value = ? WHERE key = ?', ['6', 'schema_version']);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

afterEach(() => {
  for (const dbPath of cleanupPaths.splice(0)) cleanupDbPath(dbPath);
});

describe('automatic migration safety', () => {
  test('backs up an existing outdated database before migrating and preserves data', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);
    const migratedVersion = db
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    const memory = db.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    db.close();

    const backups = backupPaths(dbPath);
    expect(backups).toHaveLength(1);
    expect(migratedVersion.value).toBe(String(SCHEMA_VERSION));
    expect(memory.content).toBe('important data');

    const backupDb = new Database(backups[0]!, { readonly: true });
    const backupVersion = backupDb
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    backupDb.close();
    expect(backupVersion.value).toBe('6');
  });

  test('restores the backup and removes stale WAL files when validation fails', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    expect(() =>
      openDatabaseWithSafeMigrations(dbPath, {
        validateDatabase: () => {
          throw new Error('forced validation failure');
        },
      })
    ).toThrow(/restored backup.*forced validation failure/);

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const restoredDb = new Database(dbPath, { readonly: true });
    const version = restoredDb
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    const memory = restoredDb.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    restoredDb.close();

    expect(version.value).toBe('6');
    expect(memory.content).toBe('important data');
  });

  test('does not create a migration backup for a current database', () => {
    const dbPath = tempDbPath();
    createCurrentDb(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    expect(backupPaths(dbPath)).toHaveLength(0);
  });

  test('migrates a v8 database to v10 and backfills the trigram index', () => {
    const dbPath = tempDbPath();
    createV8Database(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);
    const version = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
      value: string;
    };
    const main = db.query('SELECT rowid FROM memories_fts ORDER BY rowid').all() as {
      rowid: number;
    }[];
    // Contentless trigram rows expose NULL columns, so parity is by rowid.
    const trigram = db.query('SELECT rowid FROM memories_fts_trigram ORDER BY rowid').all() as {
      rowid: number;
    }[];
    db.close();

    const backups = backupPaths(dbPath);
    expect(backups).toHaveLength(1);
    expect(version.value).toBe('10');
    expect(trigram).toEqual(main);
    expect(trigram.length).toBe(1);

    const backupDb = new Database(backups[0]!, { readonly: true });
    const backupVersion = backupDb
      .query('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as {
      value: string;
    };
    backupDb.close();
    expect(backupVersion.value).toBe('8');
  });

  test('rejects a v10 database whose trigram index has orphan entries', () => {
    const dbPath = tempDbPath();
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);
    db.exec(
      "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'project', 'migration test')"
    );
    db.exec(
      "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', 'kept', 'important data', 2)"
    );
    db.exec("INSERT INTO memories_fts(rowid, name, content) VALUES (1, 'kept', 'important data')");
    // Orphan trigram row: rowid 999 has no matching memories.fts_id.
    db.exec(
      "INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (999, 'ghost', 'orphan entry')"
    );

    expect(() => validateMigratedDatabase(db)).toThrow(/orphan trigram/);
    db.close();
  });

  test('does not create a migration backup for a fresh database', () => {
    const dbPath = tempDbPath();

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    expect(existsSync(dbPath)).toBe(true);
    expect(backupPaths(dbPath)).toHaveLength(0);
  });

  test('retains only the last three automatic migration backups per database path', () => {
    const dbPath = tempDbPath();
    createV7Database(dbPath);
    markDbOutdated(dbPath);

    const oldBackups = ['20000101T000000000Z', '20000102T000000000Z', '20000103T000000000Z'];
    oldBackups.forEach((stamp, index) => {
      const path = join(dirname(dbPath), `${basename(dbPath)}.migration-backup.${stamp}.db`);
      writeFileSync(path, `old-backup-${index}`);
      const mtime = new Date(Date.UTC(2000, 0, index + 1));
      utimesSync(path, mtime, mtime);
    });

    const db = openDatabaseWithSafeMigrations(dbPath);
    db.close();

    const backups = getAutomaticMigrationBackupPaths(dbPath);
    expect(backups).toHaveLength(3);
    expect(backups.some(path => path.includes('20000101T000000000Z'))).toBe(false);
  });

  test('rejects a v10 database whose trigram DDL lacks the v10 options', () => {
    const dbPath = tempDbPath();
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);
    db.exec('DROP TABLE memories_fts_trigram');
    db.exec(
      "CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(name, content, tokenize='trigram')"
    );
    expect(() => validateMigratedDatabase(db)).toThrow(/remove_diacritics/);
    db.close();
  });
});

// ── v9→v10 functional equivalence ──

const EQUIVALENCE_DOCS = [
  {
    id: '00000000000000000000000000000011',
    name: 'accented',
    content: 'configuración año pasado',
    tier: 2,
  },
  {
    id: '00000000000000000000000000000012',
    name: 'substring',
    content: 'zebrawordishly moonword',
    tier: 2,
  },
  { id: '00000000000000000000000000000013', name: 'typo', content: 'embeddings provider', tier: 2 },
];

const EQUIVALENCE_QUERIES = [
  'configuracion',
  'configuración',
  'iguration',
  'embeddigs',
  'zebraword',
  'año',
];

function seedFtsRows(db: Database): void {
  let ftsId = 1;
  for (const doc of EQUIVALENCE_DOCS) {
    db.run(
      "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES (?, ?, '00000000000000000000000000000001', ?, ?, ?)",
      [doc.id, ftsId, doc.name, doc.content, doc.tier]
    );
    db.run('INSERT INTO memories_fts(rowid, name, content) VALUES (?, ?, ?)', [
      ftsId,
      doc.name,
      doc.content,
    ]);
    db.run('INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (?, ?, ?)', [
      ftsId,
      doc.name,
      doc.content,
    ]);
    ftsId += 1;
  }
}

function createV9WithDocs(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db);
  db.exec('DROP TABLE memories_fts_trigram');
  db.exec(
    "CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(name, content, tokenize='trigram')"
  );
  db.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'proj', '')"
  );
  seedFtsRows(db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

async function searchAll(
  store: ReturnType<typeof createSqliteStore>
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const query of EQUIVALENCE_QUERIES) {
    out[query] = (await store.search(query)).map(result => result.name).sort();
  }
  return out;
}

describe('v9→v10 functional equivalence (fresh vs migrated)', () => {
  test('same queries yield the same results on a fresh and a migrated database', async () => {
    // Fresh v10, seeded through the store.
    const freshPath = tempDbPath();
    const freshStore = createSqliteStore(freshPath);
    freshStore.createSpace('proj', 'Project', ['type:project']);
    for (const doc of EQUIVALENCE_DOCS) {
      await freshStore.addMemory('proj', doc.name, doc.content, {
        tags: ['type:project'],
        tier: doc.tier as 1 | 2 | 3,
      });
    }
    const fresh = await searchAll(freshStore);
    freshStore.close();

    // Migrated v9→v10 (no dictionary backfill).
    const migratedPath = tempDbPath();
    createV9WithDocs(migratedPath);
    const migratedStore = createSqliteStore(migratedPath);
    const migrated = await searchAll(migratedStore);
    migratedStore.close();

    for (const query of EQUIVALENCE_QUERIES) {
      const migratedResult = migrated[query];
      const freshResult = fresh[query];
      if (migratedResult === undefined || freshResult === undefined) {
        throw new Error(`missing search results for query: ${query}`);
      }
      expect(migratedResult).toEqual(freshResult);
    }
    // Sanity: R1 recall is preserved on the migrated copy.
    expect(migrated['configuracion']).toContain('accented');
  });
});

// ── Direct v9→v10 migration: final DDL, no dictionary, data preserved ──

/** Rowids of an FTS table in ascending order. */
function ftsIds(db: Database, table: string): number[] {
  return (db.query(`SELECT rowid FROM ${table} ORDER BY rowid`).all() as { rowid: number }[]).map(
    row => row.rowid
  );
}

describe('v9→v10 direct migration', () => {
  test('builds the final trigram DDL, creates no dictionary and preserves data', () => {
    const dbPath = tempDbPath();
    createV9Database(dbPath);

    const db = openDatabaseWithSafeMigrations(dbPath);

    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('10');

    const trigramSql = (
      db.query("SELECT sql FROM sqlite_master WHERE name = 'memories_fts_trigram'").get() as {
        sql: string;
      }
    ).sql.toLowerCase();
    expect(trigramSql).toContain('remove_diacritics');
    expect(trigramSql).toContain('contentless_delete=1');

    // No dictionary tables or index are ever created by the final v10 schema.
    for (const name of ['search_terms', 'memory_terms', 'idx_memory_terms_term']) {
      expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get(name)).toBeNull();
    }

    // Data preserved (count + spot check) and trigram MATCH works.
    const count = db.query('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
    expect(count.c).toBe(1);
    const kept = db.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    expect(kept.content).toBe('important data');
    const match = db
      .query('SELECT rowid FROM memories_fts_trigram WHERE memories_fts_trigram MATCH ?')
      .all('"mportant"') as { rowid: number }[];
    expect(match).toEqual([{ rowid: 1 }]);

    // A v9 database is backed up before the v9→v10 migration.
    const backups = backupPaths(dbPath);
    expect(backups).toHaveLength(1);
    db.close();

    const backupDb = new Database(backups[0]!, { readonly: true });
    const backupVersion = backupDb
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    backupDb.close();
    expect(backupVersion.value).toBe('9');
  });

  test('insert/update/delete/space-delete/import keep both indexes in lockstep after migration', async () => {
    const dbPath = tempDbPath();
    createV9Database(dbPath);

    // createSqliteStore opens through the safe-migration wrapper (v9→v10).
    const store = createSqliteStore(dbPath);
    const db = new Database(dbPath);
    try {
      store.createSpace('extra', 'Extra', ['test']);
      const added = await store.addMemory('extra', 'alpha', 'alpha content', { tags: ['test'] });
      expect(ftsIds(db, 'memories_fts_trigram')).toEqual(ftsIds(db, 'memories_fts'));

      await store.updateMemory(added.id, { content: 'gamma content' });
      expect(ftsIds(db, 'memories_fts_trigram')).toEqual(ftsIds(db, 'memories_fts'));

      store.deleteMemory(added.id);
      expect(ftsIds(db, 'memories_fts_trigram')).toEqual(ftsIds(db, 'memories_fts'));

      store.deleteSpace('extra');
      expect(ftsIds(db, 'memories_fts_trigram')).toEqual(ftsIds(db, 'memories_fts'));

      store.importFromJson({
        legacy: {
          description: 'Legacy',
          memories: [{ name: 'old', description: 'older content' }],
        },
      });
      expect(ftsIds(db, 'memories_fts_trigram')).toEqual(ftsIds(db, 'memories_fts'));
      expect(ftsIds(db, 'memories_fts_trigram').length).toBe(2); // 'kept' + 'old'

      // Writes never resurrect a dictionary.
      for (const name of ['search_terms', 'memory_terms']) {
        expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get(name)).toBeNull();
      }
    } finally {
      db.close();
      store.close();
    }
  });

  test('a forced validation failure restores the v9 backup and keeps memories', () => {
    const dbPath = tempDbPath();
    createV9Database(dbPath);

    expect(() =>
      openDatabaseWithSafeMigrations(dbPath, {
        validateDatabase: () => {
          throw new Error('forced v9→v10 validation failure');
        },
      })
    ).toThrow(/restored backup.*forced v9→v10 validation failure/);

    // WAL/SHM cleaned up and the original v9 database is intact.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const restored = new Database(dbPath, { readonly: true });
    const version = restored.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    const memory = restored.query('SELECT content FROM memories WHERE name = ?').get('kept') as {
      content: string;
    };
    restored.close();

    expect(version.value).toBe('9');
    expect(memory.content).toBe('important data');
  });

  test('ensureIntegrity repairs a drifted trigram index after migration without losing memories', async () => {
    const dbPath = tempDbPath();
    createV9Database(dbPath);

    // First open migrates v9→v10 and seeds one more memory through the store.
    const seed = createSqliteStore(dbPath);
    await seed.addMemory('project', 'extra', 'extra content', { tags: ['test'] });
    seed.close();

    // Drift the derived index behind the store's back.
    const writable = new Database(dbPath);
    writable.run('DELETE FROM memories_fts_trigram WHERE rowid = 1');
    writable.run(
      "INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (999, 'ghost', 'orphan')"
    );
    writable.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    writable.close();

    // Reopening runs ensureIntegrity, which uses delete-all + repopulate.
    const repaired = createSqliteStore(dbPath);
    const read = new Database(dbPath);
    try {
      expect(ftsIds(read, 'memories_fts_trigram')).toEqual(ftsIds(read, 'memories_fts'));
      const memories = read.query('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
      expect(memories.c).toBe(2);
      const results = await repaired.search('important');
      expect(results.map(result => result.name)).toEqual(['kept']);
    } finally {
      read.close();
      repaired.close();
    }
  });
});
