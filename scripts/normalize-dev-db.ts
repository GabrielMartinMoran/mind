#!/usr/bin/env bun
// ── Opt-in normalizer for DEV databases stamped schema_version = 11 ──
//
// Background: the schemas `v10` (with a per-document search-term dictionary)
// and `v11` (dictionary retired) were **development-only** and were never
// published. The last published schema was `v9`, and the final consolidated
// schema is now `v10` — functionally identical to that dev-only `v11`.
//
// Because the engine no longer carries any permanent `v10 → v11` compatibility,
// a dev database left stamped `11` is simply treated as "already newer" and is
// never revalidated. This one-shot utility makes such a database honest again:
//
//   1. refuses to run against the live `data/mind.db` (copies only);
//   2. verifies the database is exactly schema_version 11, that it has NO
//      dictionary tables (`search_terms`, `memory_terms`) and that its trigram
//      index carries the final `remove_diacritics 1` + contentless DDL;
//   3. backs it up with `VACUUM INTO` before any change;
//   4. rewrites `meta.schema_version` to `10` (functional equivalence:
//      dev v11 == final v10);
//   5. validates `quick_check`, foreign keys, table counts and a trigram MATCH,
//      restoring the backup and exiting non-zero if anything fails.
//
// Usage:
//   bun run scripts/normalize-dev-db.ts <path-to-dev.db>
//   bun run scripts/normalize-dev-db.ts --help
//
// It is NEVER run automatically and NEVER against `data/mind.db`.

import { copyFileSync, existsSync, realpathSync, rmSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { Database } from 'bun:sqlite';

const DICTIONARY_TABLES = ['search_terms', 'memory_terms', 'idx_memory_terms_term'];
const TARGET_VERSION = 10;
const SOURCE_VERSION = 11;

function printHelp(): void {
  process.stdout.write(
    [
      'normalize-dev-db — rewrite a dev-only schema_version=11 database to the final v10.',
      '',
      'Usage: bun run scripts/normalize-dev-db.ts <path-to-dev.db>',
      '       bun run scripts/normalize-dev-db.ts --help',
      '',
      'The database must be schema_version 11 with no dictionary tables and the',
      'final trigram DDL (remove_diacritics 1 + contentless_delete=1). A backup is',
      'written next to it as <db>.pre-normalize.<stamp>.db before the rewrite.',
      '',
      'The live data/mind.db is refused; operate on a copy.',
      '',
    ].join('\n')
  );
}

interface Counts {
  spaces: number;
  memories: number;
  memory_tags: number;
  links: number;
}

function liveDbPath(): string {
  // scripts/ lives at the repo root, so ../data/mind.db relative to this file.
  return join(dirname(new URL(import.meta.url).pathname), '..', 'data', 'mind.db');
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function queryCounts(db: Database): Counts {
  return db
    .query(
      `SELECT (SELECT COUNT(*) FROM spaces) AS spaces,
              (SELECT COUNT(*) FROM memories) AS memories,
              (SELECT COUNT(*) FROM memory_tags) AS memory_tags,
              (SELECT COUNT(*) FROM links) AS links`
    )
    .get() as Counts;
}

function readSchemaVersion(db: Database): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  return row?.value ?? null;
}

function trigramDdl(db: Database): string {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts_trigram'")
    .get() as { sql: string } | null;
  return (row?.sql ?? '').toLowerCase();
}

function dictionaryTablesPresent(db: Database): string[] {
  return DICTIONARY_TABLES.filter(
    name => db.query('SELECT name FROM sqlite_master WHERE name = ?').get(name) !== null
  );
}

/** A trigram MATCH query built from the first document, or null for an empty DB. */
function sampleTrigramQuery(db: Database): string | null {
  const row = db.query('SELECT name, content FROM memories LIMIT 1').get() as {
    name: string;
    content: string;
  } | null;
  if (!row) return null;
  const match = /[\p{L}\p{N}]{3,}/u.exec(`${row.name} ${row.content}`);
  return match ? `"${match[0]}"` : null;
}

function validateFinal(db: Database, expected: Counts): void {
  const quickCheck = db.query('PRAGMA quick_check').get() as { quick_check: string } | null;
  if (quickCheck?.quick_check !== 'ok') {
    throw new Error(`PRAGMA quick_check failed: ${quickCheck?.quick_check ?? 'no result'}`);
  }

  const fkProblems = db.query('PRAGMA foreign_key_check').all() as unknown[];
  if (fkProblems.length > 0) {
    throw new Error(`PRAGMA foreign_key_check found ${fkProblems.length} problem(s)`);
  }

  const version = readSchemaVersion(db);
  if (version !== String(TARGET_VERSION)) {
    throw new Error(`expected schema_version ${TARGET_VERSION}, found ${version ?? 'unknown'}`);
  }

  const after = queryCounts(db);
  for (const key of Object.keys(expected) as (keyof Counts)[]) {
    if (after[key] !== expected[key]) {
      throw new Error(`count mismatch for ${key}: ${after[key]} != ${expected[key]}`);
    }
  }

  const sample = sampleTrigramQuery(db);
  if (sample) {
    const hits = db
      .query('SELECT rowid FROM memories_fts_trigram WHERE memories_fts_trigram MATCH ?')
      .all(sample) as unknown[];
    if (hits.length === 0) {
      throw new Error(`trigram MATCH returned no rows for sample query ${sample}`);
    }
  }
}

function main(argv: string[]): void {
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      printHelp();
      if (argv.length === 0) process.exit(2);
      return;
    }
    throw new Error(`expected exactly one database path, got ${argv.length} arguments`);
  }

  const dbPath = resolve(argv[0]!);

  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new Error(`database not found: ${dbPath}`);
  }
  if (samePath(dbPath, liveDbPath())) {
    throw new Error(
      `refusing to normalize the live database (${liveDbPath()}); operate on a copy instead`
    );
  }

  const db = new Database(dbPath);
  let backupPath: string | null = null;
  let backedUp = false;

  try {
    const version = readSchemaVersion(db);
    if (version !== String(SOURCE_VERSION)) {
      throw new Error(
        `expected a dev schema_version ${SOURCE_VERSION} database, found ${version ?? 'unknown'}`
      );
    }

    const dictionaries = dictionaryTablesPresent(db);
    if (dictionaries.length > 0) {
      throw new Error(
        `database still has dictionary table(s) ${dictionaries.join(', ')}; it is not a ` +
          'dictionary-free dev v11 database'
      );
    }

    const ddl = trigramDdl(db);
    if (!ddl || !ddl.includes('remove_diacritics') || !ddl.includes('contentless_delete=1')) {
      throw new Error('memories_fts_trigram does not carry the final v10 DDL');
    }

    const before = queryCounts(db);

    // Flush WAL so the backup captures every committed row, then back up.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    backupPath = `${dbPath}.pre-normalize.${stamp}.db`;
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
    backedUp = true;

    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(TARGET_VERSION)]);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    validateFinal(db, before);

    process.stdout.write(
      [
        `Normalized ${dbPath}`,
        `  schema_version: ${SOURCE_VERSION} → ${TARGET_VERSION}`,
        `  backup: ${backupPath}`,
        `  counts: ${JSON.stringify(before)}`,
        '  validation: quick_check=ok, foreign_key_check=0, trigram MATCH ok',
        '',
      ].join('\n')
    );
  } catch (error) {
    // Best-effort restore of the pre-normalize backup.
    if (backedUp && backupPath) {
      try {
        db.close();
      } catch {
        // ignore
      }
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        rmSync(path, { force: true });
      }
      copyFileSync(backupPath, dbPath);
      process.stderr.write(`Normalization failed; restored backup from ${backupPath}\n`);
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

try {
  main(Bun.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
