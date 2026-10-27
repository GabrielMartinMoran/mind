import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';

import { Database } from 'bun:sqlite';

import { SCHEMA_VERSION, initializeDatabase } from './schema';
import { trigramIndexProblems } from './shared/fts-helpers';

type ValidateDatabase = (db: Database) => void;

interface MigrationSafetyOptions {
  validateDatabase?: ValidateDatabase;
  now?: () => Date;
}

let backupCounter = 0;

const BACKUP_KEEP_COUNT = 3;
const BACKUP_MARKER = '.migration-backup.';

export function openDatabaseWithSafeMigrations(
  dbPath: string,
  options: MigrationSafetyOptions = {}
): Database {
  const existedBeforeOpen = existsSync(dbPath);
  const db = new Database(dbPath, { create: true });
  const startingVersion = existedBeforeOpen ? readSchemaVersionIfPossible(db) : null;
  const needsMigrationBackup = startingVersion !== null && startingVersion < SCHEMA_VERSION;

  if (!needsMigrationBackup) {
    initializeDatabase(db);
    return db;
  }

  const backupPath = createMigrationBackup(db, dbPath, options.now?.() ?? new Date());

  try {
    initializeDatabase(db);
    const validate = options.validateDatabase ?? validateMigratedDatabase;
    validate(db);
    pruneAutomaticMigrationBackups(dbPath);
    return db;
  } catch (error) {
    closeQuietly(db);
    try {
      restoreMigrationBackup(dbPath, backupPath);
      pruneAutomaticMigrationBackups(dbPath);
    } catch (restoreError) {
      throw new Error(
        `Automatic DB migration failed and restore from backup ${backupPath} failed: ${errorMessage(restoreError)} (migration error: ${errorMessage(error)})`
      );
    }
    throw new Error(
      `Automatic DB migration failed; restored backup from ${backupPath}: ${errorMessage(error)}`
    );
  }
}

export function getAutomaticMigrationBackupPaths(dbPath: string): string[] {
  const parent = dirname(dbPath);
  if (!existsSync(parent)) return [];

  const prefix = `${basename(dbPath)}${BACKUP_MARKER}`;
  return readdirSync(parent)
    .filter(name => name.startsWith(prefix))
    .map(name => join(parent, name))
    .sort((left, right) => compareBackupNewestFirst(left, right));
}

function readSchemaVersionIfPossible(db: Database): number | null {
  try {
    const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
      value: string;
    } | null;
    if (!row) return null;

    const version = Number.parseInt(row.value, 10);
    return Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
}

function createMigrationBackup(db: Database, dbPath: string, now: Date): string {
  const backupPath = nextBackupPath(dbPath, now);
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  return backupPath;
}

function nextBackupPath(dbPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const parent = dirname(dbPath);
  const base = basename(dbPath);

  let candidate = join(
    parent,
    `${base}${BACKUP_MARKER}${stamp}-${process.pid}-${backupCounter++}.db`
  );
  while (existsSync(candidate)) {
    candidate = join(
      parent,
      `${base}${BACKUP_MARKER}${stamp}-${process.pid}-${backupCounter++}.db`
    );
  }
  return candidate;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function validateMigratedDatabase(db: Database): void {
  const version = readSchemaVersionIfPossible(db);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`expected schema version ${SCHEMA_VERSION}, found ${version ?? 'unknown'}`);
  }

  const quickCheck = db.query('PRAGMA quick_check').get() as { quick_check: string } | null;
  if (quickCheck?.quick_check !== 'ok') {
    throw new Error(`PRAGMA quick_check failed: ${quickCheck?.quick_check ?? 'no result'}`);
  }

  const foreignKeyProblems = db.query('PRAGMA foreign_key_check').all() as unknown[];
  if (foreignKeyProblems.length > 0) {
    throw new Error(`PRAGMA foreign_key_check found ${foreignKeyProblems.length} problem(s)`);
  }

  // v8-specific validation
  if (version >= 8) {
    validateV8Database(db);
  }

  // v9 adds the standalone trigram FTS5 index; validate its sync parity.
  if (version >= 9) {
    validateV9Database(db);
  }

  // v10 recreates the trigram index with diacritic folding + contentless
  // semantics; validate it.
  if (version >= 10) {
    validateV10Database(db);
  }
}

function validateV8Database(db: Database): void {
  const nullMemoryIds = db
    .query("SELECT COUNT(*) as c FROM memories WHERE id IS NULL OR id = ''")
    .get() as { c: number };
  if (nullMemoryIds.c > 0) {
    throw new Error(`Found ${nullMemoryIds.c} memories with null or empty UUID id`);
  }
  const nullSpaceIds = db
    .query("SELECT COUNT(*) as c FROM spaces WHERE id IS NULL OR id = ''")
    .get() as { c: number };
  if (nullSpaceIds.c > 0) {
    throw new Error(`Found ${nullSpaceIds.c} spaces with null or empty UUID id`);
  }
  const dupFtsIds = db
    .query(
      'SELECT COUNT(*) as c FROM (SELECT fts_id FROM memories GROUP BY fts_id HAVING COUNT(*) > 1)'
    )
    .get() as { c: number };
  if (dupFtsIds.c > 0) {
    throw new Error(`Found ${dupFtsIds.c} duplicate fts_id values in memories`);
  }
  const orphanFts = db
    .query(
      'SELECT COUNT(*) as c FROM memories_fts fts LEFT JOIN memories m ON m.fts_id = fts.rowid WHERE m.id IS NULL'
    )
    .get() as { c: number };
  if (orphanFts.c > 0) {
    throw new Error(`Found ${orphanFts.c} orphan FTS entries without matching memories`);
  }
  const danglingTags = db
    .query('SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)')
    .get() as { c: number };
  if (danglingTags.c > 0) {
    throw new Error(`Found ${danglingTags.c} memory tags referencing non-existent memories`);
  }
  const danglingLinksSrc = db
    .query('SELECT COUNT(*) as c FROM links WHERE source_id NOT IN (SELECT id FROM memories)')
    .get() as { c: number };
  if (danglingLinksSrc.c > 0) {
    throw new Error(`Found ${danglingLinksSrc.c} links with non-existent source memories`);
  }
  const danglingLinksTgt = db
    .query('SELECT COUNT(*) as c FROM links WHERE target_id NOT IN (SELECT id FROM memories)')
    .get() as { c: number };
  if (danglingLinksTgt.c > 0) {
    throw new Error(`Found ${danglingLinksTgt.c} links with non-existent target memories`);
  }
  const seq = db
    .query("SELECT next_value FROM fts_id_sequence WHERE entity = 'memories'")
    .get() as { next_value: number } | null;
  if (!seq) {
    throw new Error('fts_id_sequence missing entry for memories');
  }
}

/** v9 adds the standalone trigram FTS5 index; validate it has no orphans. */
function validateV9Database(db: Database): void {
  const orphanTrigram = db
    .query(
      'SELECT COUNT(*) as c FROM memories_fts_trigram tri LEFT JOIN memories m ON m.fts_id = tri.rowid WHERE m.id IS NULL'
    )
    .get() as { c: number };
  if (orphanTrigram.c > 0) {
    throw new Error(
      `Found ${orphanTrigram.c} orphan trigram FTS entries without matching memories`
    );
  }
}

/**
 * v10: the trigram index must carry `remove_diacritics` and
 * `contentless_delete=1` in its stored DDL and stay in count/rowid parity with
 * `memories`.
 */
function validateV10Database(db: Database): void {
  const ddl = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts_trigram'")
    .get() as { sql: string } | null;
  if (!ddl) {
    throw new Error('memories_fts_trigram is missing');
  }
  const sql = ddl.sql.toLowerCase();
  if (!sql.includes('remove_diacritics')) {
    throw new Error('memories_fts_trigram is missing remove_diacritics');
  }
  if (!sql.includes('contentless_delete=1')) {
    throw new Error('memories_fts_trigram is missing contentless_delete=1');
  }

  const trigramProblems = trigramIndexProblems(db);
  if (trigramProblems.length > 0) {
    throw new Error(`trigram index inconsistency: ${trigramProblems.join('; ')}`);
  }
}

function restoreMigrationBackup(dbPath: string, backupPath: string): void {
  removeDatabaseFiles(dbPath);
  copyFileSync(backupPath, dbPath);
}

function removeDatabaseFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(path, { force: true });
  }
}

function pruneAutomaticMigrationBackups(dbPath: string): void {
  const backups = getAutomaticMigrationBackupPaths(dbPath);
  for (const backupPath of backups.slice(BACKUP_KEEP_COUNT)) {
    rmSync(backupPath, { force: true });
  }
}

function compareBackupNewestFirst(left: string, right: string): number {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  if (rightStat.mtimeMs !== leftStat.mtimeMs) return rightStat.mtimeMs - leftStat.mtimeMs;
  return right.localeCompare(left);
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // Best-effort close before replacing database files.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
