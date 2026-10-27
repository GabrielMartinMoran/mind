// ── Trigram substring + fuzzy channels, sync parity and schema v10 ──

import { existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { openDatabaseWithSafeMigrations } from '../src/store/migration-safety';
import {
  damerauLevenshtein,
  expandFuzzyTokens,
  FUZZY_MAX_EXPANSIONS,
  type ScoredSearchResult,
} from '../src/store/repositories/search-repository';
import { SCHEMA_VERSION, initializeDatabase } from '../src/store/schema';
import { FtsHelper, recoverTrigramIndex } from '../src/store/shared/fts-helpers';
import { createSqliteStore } from '../src/store/sqlite-store';

let counter = 0;
const cleanupQueue: (() => void)[] = [];

afterEach(() => {
  while (cleanupQueue.length > 0) cleanupQueue.pop()!();
});

function tempDbPath(): string {
  return join(tmpdir(), `mind-trigram-${Date.now()}-${counter++}.db`);
}

/** Remove a db path plus WAL/SHM and any automatic migration backups. */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
  const parent = dirname(dbPath);
  if (existsSync(parent)) {
    const prefix = `${basename(dbPath)}.migration-backup.`;
    for (const name of readdirSync(parent)) {
      if (name.startsWith(prefix)) rmSync(join(parent, name), { force: true });
    }
  }
}

/** Store + a second read connection to the same file, for parity assertions. */
function createStoreWithDb() {
  const dbPath = tempDbPath();
  const store = createSqliteStore(dbPath);
  const db = new Database(dbPath);
  cleanupQueue.push(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    store.close();
    removeDbFiles(dbPath);
  });
  return { store, db };
}

function ftsRows(
  db: Database,
  table: string
): { rowid: number; name: string | null; content: string | null }[] {
  return db.query(`SELECT rowid, name, content FROM ${table} ORDER BY rowid`).all() as {
    rowid: number;
    name: string | null;
    content: string | null;
  }[];
}

function ftsRowIds(db: Database, table: string): number[] {
  return (db.query(`SELECT rowid FROM ${table} ORDER BY rowid`).all() as { rowid: number }[]).map(
    row => row.rowid
  );
}

/** Rowids matched by a raw FTS5 MATCH string on the trigram index. */
function trigramMatch(db: Database, match: string): number[] {
  return (
    db
      .query(
        'SELECT rowid FROM memories_fts_trigram WHERE memories_fts_trigram MATCH ? ORDER BY rowid'
      )
      .all(match) as { rowid: number }[]
  ).map(row => row.rowid);
}

describe('Damerau–Levenshtein distance', () => {
  test('computes substitutions, insertions and transpositions', () => {
    expect(damerauLevenshtein('embeddigs', 'embeddings')).toBe(1);
    expect(damerauLevenshtein('mohabilboo', 'mohabilbo')).toBe(1);
    expect(damerauLevenshtein('cart', 'crat')).toBe(1); // transposition
    expect(damerauLevenshtein('cache', 'cache')).toBe(0);
    expect(damerauLevenshtein('puntroca', 'puntaroca')).toBe(1);
    expect(damerauLevenshtein('aaaa', 'bbbb')).toBe(4);
  });
});

describe('fuzzy expansion cap', () => {
  test('caps expansions and is deterministic', () => {
    // Unique + default-sorted vocabulary is the caller's precondition.
    const vocabulary = Array.from({ length: 60 }, (_v, i) => `hello${i}`).sort();
    const expansions = expandFuzzyTokens(['hello'], vocabulary);
    const terms = expansions.get('hello')!;
    expect(terms.length).toBe(FUZZY_MAX_EXPANSIONS);
    expect(terms).toEqual([...terms].sort());

    const small = expandFuzzyTokens(['hello'], vocabulary, 10);
    expect(small.get('hello')!.length).toBe(10);
  });

  test('respects length and max-distance constraints', () => {
    const expansions = expandFuzzyTokens(['cache'], ['ca', 'caché', 'puntaroca']);
    expect(expansions.get('cache')).toEqual(['caché']);
  });

  test('documented P-A prefix-3 floor: a first-3-character typo is not expanded', () => {
    // P-A restores the ≥3 shared-prefix requirement on the fuzzy scan (fallback
    // from the retired v10 dictionary). A candidate sharing fewer than three
    // leading characters with the query token is out of scope by design.
    expect(expandFuzzyTokens(['xmbeddings'], ['embeddings']).get('xmbeddings')).toEqual([]);
    // "cach"/"cash" share only "ca" (2 < 3): not expanded.
    expect(expandFuzzyTokens(['cach'], ['cash']).get('cach')).toEqual([]);
    // "cach"/"cache" share "cach" (4 ≥ 3): expanded.
    expect(expandFuzzyTokens(['cach'], ['cache']).get('cach')).toEqual(['cache']);
  });
});

describe('MindStore — trigram substring channel', () => {
  test('finds a substring embedded inside a word', async () => {
    const { store } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'config-doc', 'configuration settings', { tags: ['test'] });

    const results = await store.search('iguration');
    expect(results.map(r => r.name)).toEqual(['config-doc']);
  });

  test('terms shorter than three characters skip the trigram channel', async () => {
    const { store } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'embedded', 'zzabzz only', { tags: ['test'] });

    // A two-character term cannot be indexed by trigram (which needs >=3
    // characters), so the trigram channel must contribute no candidates. The
    // short term is still served by the LIKE channel, so the *result set* is
    // not required to be empty — only the trigram provenance must be absent.
    const results = (await store.search('ab')) as ScoredSearchResult[];
    expect(results.map(r => r.name)).toEqual(['embedded']);
    expect(results[0]!.methods).not.toContain('trigram');
  });

  test('substring channel stays quiet when a stricter channel already matched', async () => {
    const { store } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'strict-doc', 'zebraword moonword', { tags: ['test'] });
    // Matches only the trigram substring of "zebraword" (not a token match).
    await store.addMemory('test', 'substr-only', 'zebrawordishly', { tags: ['test'] });

    const results = await store.search('zebraword moonword');
    expect(results.map(r => r.name)).toEqual(['strict-doc']);
  });
});

describe('MindStore — fuzzy typo channel', () => {
  test('finds a memory within two edits of an indexed term', async () => {
    const { store } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'emb-doc', 'embeddings provider', { tags: ['test'] });

    const results = await store.search('embeddigs');
    expect(results.map(r => r.name)).toEqual(['emb-doc']);
  });

  test('transposition typo is tolerated', async () => {
    const { store } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'arcana', 'puntaroca settlement', { tags: ['test'] });

    const results = await store.search('puntroca');
    expect(results.map(r => r.name)).toEqual(['arcana']);
  });
});

describe('R1 — diacritic folding in the contentless trigram index', () => {
  test('folded and accented terms match both directions', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'accented', 'configuración año', { tags: ['test'] });

    // Folded query vs accented document (the R1 fix) …
    expect(trigramMatch(db, '"configuracion"')).toEqual([1]);
    // … and accented query vs accented document (already worked, must not regress).
    expect(trigramMatch(db, '"configuración"')).toEqual([1]);
    // ñ folds to n in both directions.
    expect(trigramMatch(db, '"ano"')).toEqual([1]);
    expect(trigramMatch(db, '"año"')).toEqual([1]);
  });

  test('case is folded', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'accented', 'configuración', { tags: ['test'] });

    expect(trigramMatch(db, '"CONFIGURACION"')).toEqual([1]);
  });

  test('precomposed and combining forms are equivalent', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'precomposed', 'café notes', { tags: ['test'] });

    expect(trigramMatch(db, '"cafe"')).toEqual([1]);
    // Combining acute accent (U+0301) folds to the same term.
    expect(trigramMatch(db, '"cafe\u0301"')).toEqual([1]);
  });

  test('the año/ano distinction collapses under folding', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'with-tilde', 'el año pasado', { tags: ['test'] });
    await store.addMemory('test', 'without', 'ano plain', { tags: ['test'] });

    // Documented, accepted trade-off of remove_diacritics: both documents match
    // either spelling at the trigram layer. Ranking/other channels still decide.
    expect(trigramMatch(db, '"año"').sort()).toEqual([1, 2]);
    expect(trigramMatch(db, '"ano"').sort()).toEqual([1, 2]);
  });

  test('sub-trigram accented queries stay out of the trigram index', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'accented', 'configuración', { tags: ['test'] });

    // "añ" folds to "an" (2 chars) — below the trigram minimum.
    expect(trigramMatch(db, '"añ"')).toEqual([]);
  });

  test('update replaces old accented terms and introduces new ones', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'doc', 'configuración settings', { tags: ['test'] });

    await store.updateMemory(mem.id, { content: 'geografía notes' });

    expect(mem.fts_id).toBeDefined();
    expect(trigramMatch(db, '"iguración"')).toEqual([]);
    expect(trigramMatch(db, '"ografía"')).toEqual([mem.fts_id!]);
    // id and fts_id are preserved across the update.
    const row = db.query('SELECT id, fts_id FROM memories WHERE id = ?').get(mem.id) as {
      id: string;
      fts_id: number;
    };
    expect(row.fts_id).toBe(mem.fts_id!);
  });

  test('delete removes accented terms from the trigram index', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'doc', 'configuración', { tags: ['test'] });
    expect(trigramMatch(db, '"configuracion"')).toEqual([mem.fts_id!]);

    store.deleteMemory(mem.id);
    expect(trigramMatch(db, '"configuracion"')).toEqual([]);
  });
});

describe('MindStore — FTS sync parity (main == trigram)', () => {
  test('add keeps both indexes in lockstep', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'alpha content', { tags: ['test'] });
    await store.addMemory('test', 'b', 'beta content', { tags: ['test'] });

    expect(ftsRowIds(db, 'memories_fts_trigram')).toEqual(ftsRowIds(db, 'memories_fts'));
  });

  test('contentless trigram columns read back as NULL', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'alpha content', { tags: ['test'] });

    const rows = ftsRows(db, 'memories_fts_trigram');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBeNull();
    expect(rows[0]!.content).toBeNull();
    // The main porter index still stores the columns.
    expect(ftsRows(db, 'memories_fts')[0]!.content).toBe('alpha content');
  });

  test('update keeps both indexes in lockstep', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'a', 'alpha content', { tags: ['test'] });
    await store.updateMemory(mem.id, { name: 'renamed', content: 'gamma content' });

    expect(ftsRowIds(db, 'memories_fts_trigram')).toEqual(ftsRowIds(db, 'memories_fts'));
    const main = db
      .query('SELECT name, content FROM memories_fts WHERE rowid = ?')
      .get(mem.fts_id!) as { name: string; content: string };
    expect(main.name).toBe('renamed');
    expect(main.content).toBe('gamma content');
  });

  test('delete and deleteByName keep both indexes in lockstep', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    const a = await store.addMemory('test', 'a', 'alpha', { tags: ['test'] });
    await store.addMemory('test', 'b', 'beta', { tags: ['test'] });
    store.deleteMemory(a.id);
    store.deleteMemoryByName('test', 'b');

    expect(ftsRowIds(db, 'memories_fts')).toEqual([]);
    expect(ftsRowIds(db, 'memories_fts_trigram')).toEqual([]);
    expect(ftsRowIds(db, 'memories_fts')).toEqual([]);
  });

  test('space delete clears both indexes', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('doomed', 'Doomed', ['test']);
    await store.addMemory('doomed', 'a', 'alpha', { tags: ['test'] });
    await store.addMemory('doomed', 'b', 'beta', { tags: ['test'] });
    store.deleteSpace('doomed');

    expect(ftsRowIds(db, 'memories_fts')).toEqual([]);
    expect(ftsRowIds(db, 'memories_fts_trigram')).toEqual([]);
  });

  test('importFromJson keeps both indexes in lockstep', async () => {
    const { store, db } = createStoreWithDb();
    store.importFromJson({
      legacy: { description: 'Legacy', memories: [{ name: 'old', description: 'older content' }] },
    });

    expect(ftsRowIds(db, 'memories_fts_trigram')).toEqual(ftsRowIds(db, 'memories_fts'));
    expect(ftsRowIds(db, 'memories_fts_trigram').length).toBe(1);
  });

  test('bm25/rank still works on the contentless trigram index', async () => {
    const { store, db } = createStoreWithDb();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'sub', 'zebrawordishly here', { tags: ['test'] });

    const ranked = db
      .query(
        'SELECT rowid, bm25(memories_fts_trigram) AS rank FROM memories_fts_trigram WHERE memories_fts_trigram MATCH ? ORDER BY rank'
      )
      .all('"ebraword"') as { rowid: number; rank: number }[];
    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0]!.rank)).toBe(true);
  });
});

/** Build a v9-like database (old trigram DDL, no dictionary tables). */
function createV9Database(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  initializeDatabase(db); // v10 tables first
  // Regress to a v9 shape.
  db.exec('DROP TABLE memories_fts_trigram');
  db.exec(
    "CREATE VIRTUAL TABLE memories_fts_trigram USING fts5(name, content, tokenize='trigram')"
  );
  db.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
  db.exec(
    "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'proj', '')"
  );
  db.exec(
    "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('00000000000000000000000000000002', 1, '00000000000000000000000000000001', 'config-doc', 'configuración settings', 2)"
  );
  db.exec(
    "INSERT INTO memories_fts(rowid, name, content) VALUES (1, 'config-doc', 'configuración settings')"
  );
  db.exec(
    "INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (1, 'config-doc', 'configuración settings')"
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

describe('schema v10 migration (no search-term dictionary)', () => {
  test('constant is 10 and fresh databases create the v10 trigram options and no dictionary', () => {
    expect(SCHEMA_VERSION).toBe(10);
    const dbPath = tempDbPath();
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);

    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('10');

    const trigramSql = (
      db
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts_trigram'")
        .get() as { sql: string }
    ).sql.toLowerCase();
    expect(trigramSql).toContain('remove_diacritics');
    expect(trigramSql).toContain('contentless_delete=1');

    // The dev-only dictionary tables must not exist in a fresh v10 database.
    for (const table of ['search_terms', 'memory_terms']) {
      expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get(table)).toBeNull();
    }

    db.close();
    removeDbFiles(dbPath);
  });

  test('v9 database migrates to v10 with the final trigram DDL and no dictionary', () => {
    const dbPath = tempDbPath();
    createV9Database(dbPath);

    const migrated = openDatabaseWithSafeMigrations(dbPath);
    const version = migrated.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(version.value).toBe('10');

    // Final v10 trigram DDL is in place (not the old v9 `tokenize='trigram'`).
    const trigramSql = (
      migrated
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts_trigram'")
        .get() as { sql: string }
    ).sql.toLowerCase();
    expect(trigramSql).toContain('remove_diacritics');
    expect(trigramSql).toContain('contentless_delete=1');

    // Trigram repopulated and in parity.
    expect(ftsRowIds(migrated, 'memories_fts_trigram')).toEqual([1]);

    // R1 active after migration: folded query vs accented document.
    expect(trigramMatch(migrated, '"configuracion"')).toEqual([1]);

    // Data preserved.
    const memories = migrated.query('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
    expect(memories.c).toBe(1);

    // The dev-only dictionary tables never exist in the final v10 schema.
    for (const table of ['search_terms', 'memory_terms']) {
      expect(migrated.query('SELECT name FROM sqlite_master WHERE name = ?').get(table)).toBeNull();
    }

    migrated.close();
    removeDbFiles(dbPath);
  });
});

describe('derived-index recovery (FtsHelper + ensureIntegrity)', () => {
  function rawDb(): Database {
    const dbPath = tempDbPath();
    const db = new Database(dbPath, { create: true });
    initializeDatabase(db);
    cleanupQueue.push(() => {
      db.close();
      removeDbFiles(dbPath);
    });
    return db;
  }

  test('recoverTrigramIndex repopulates a drifted index (delete-all path)', () => {
    const db = rawDb();
    const fts = new FtsHelper(db);
    db.run(
      "INSERT INTO spaces (id, name, description) VALUES ('00000000000000000000000000000001', 'p', '')"
    );
    db.run(
      "INSERT INTO memories (id, fts_id, space_id, name, content, tier) VALUES ('m1', 1, '00000000000000000000000000000001', 'kept', 'important data', 2)"
    );
    fts.insert('m1', 1, 'kept', 'important data');
    // Corrupt: drop the valid row and leave an orphan behind.
    db.run('DELETE FROM memories_fts_trigram WHERE rowid = 1');
    db.run(
      "INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (999, 'ghost', 'orphan')"
    );

    recoverTrigramIndex(db);

    const parity = db.query('SELECT rowid FROM memories_fts_trigram ORDER BY rowid').all() as {
      rowid: number;
    }[];
    expect(parity).toEqual([{ rowid: 1 }]);
    // Functional again.
    const hit = db
      .query('SELECT rowid FROM memories_fts_trigram WHERE memories_fts_trigram MATCH ?')
      .all('"mportant"') as { rowid: number }[];
    expect(hit).toEqual([{ rowid: 1 }]);
  });

  test("FTS5 'rebuild' is unsupported on the contentless index", () => {
    const db = rawDb();
    expect(() =>
      db.exec("INSERT INTO memories_fts_trigram(memories_fts_trigram) VALUES('rebuild')")
    ).toThrow();
  });

  test('repairs a drifted trigram index on reopen without losing data', async () => {
    const dbPath = tempDbPath();
    const store = createSqliteStore(dbPath);
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'kept', 'important content', { tags: ['test'] });
    store.close();

    // Drift the derived index behind the store's back.
    const writable = new Database(dbPath);
    writable.run('DELETE FROM memories_fts_trigram WHERE rowid = 1');
    writable.run(
      "INSERT INTO memories_fts_trigram(rowid, name, content) VALUES (999, 'ghost', 'x')"
    );
    writable.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    writable.close();

    // Reopening runs ensureIntegrity, which repairs the derived index.
    const reopened = createSqliteStore(dbPath);
    const read = new Database(dbPath);
    const parity = read.query('SELECT rowid FROM memories_fts_trigram ORDER BY rowid').all() as {
      rowid: number;
    }[];
    expect(parity).toEqual([{ rowid: 1 }]);
    const memories = read.query('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
    expect(memories.c).toBe(1);
    const results = await reopened.search('important');
    expect(results.map(result => result.name)).toEqual(['kept']);

    read.close();
    reopened.close();
    removeDbFiles(dbPath);
  });
});
