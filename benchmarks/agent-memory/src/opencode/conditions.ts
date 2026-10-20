// Condition profiles and per-question database isolation for benchmark A2.
//
// A `ConditionProfile` bundles everything one condition needs to run an
// isolated OpenCode session: its own directory tree, the isolated environment
// (HOME/XDG/OPENCODE_CONFIG_CONTENT/…) and, for Mind conditions, the pinned
// worktree binary. The `judge` profile is a no-memory profile with all tools
// denied, used only for blind judging.
//
// Each A2 question runs from a byte-identical copy of the ingested condition
// database, so no question can pollute a later one.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';

import { engineForCondition, type ConditionId, type EngineVersion } from '../config';
import {
  buildOpenCodeEnv,
  isolationDirs,
  type IsolationDirs,
  type PermissionRule,
} from '../isolation/opencode';

export interface ConditionProfile {
  readonly id: ConditionId;
  readonly engine: EngineVersion | null;
  readonly dirs: IsolationDirs;
  readonly env: Record<string, string>;
  readonly mindBin: string | null;
}

export interface JudgeProfile {
  readonly id: 'judge';
  readonly dirs: IsolationDirs;
  readonly env: Record<string, string>;
}

/** Deny-all tool rule: the judge session must not call any tool. */
export const JUDGE_DENY_ALL: readonly PermissionRule[] = [
  { action: 'tool.use', resource: '*', effect: 'deny' },
];

export interface BuildProfilesInput {
  readonly runDir: string;
  readonly conditions: readonly ConditionId[];
  /** Absolute worktree paths per engine version; required for Mind conditions. */
  readonly worktrees: Partial<Record<EngineVersion, string>>;
  /**
   * Provider credential env (e.g. `OPENROUTER_API_KEY`) merged into every
   * profile's environment for paid stages. Empty/none for free stages.
   */
  readonly credentialEnv?: Record<string, string>;
}

function conditionDir(runDir: string, condition: ConditionId): string {
  return join(runDir, condition);
}

export function buildConditionProfile(
  runDir: string,
  condition: ConditionId,
  worktrees: Partial<Record<EngineVersion, string>>,
  credentialEnv: Record<string, string> = {}
): ConditionProfile {
  const engine = engineForCondition(condition);
  const dir = isolationDirs(conditionDir(runDir, condition));
  const binary = engine === null ? null : worktrees[engine];
  const mindBin = binary ? join(binary, 'mind') : null;
  return {
    id: condition,
    engine,
    dirs: dir,
    env: { ...buildOpenCodeEnv({ condition, dir, mindBin }), ...credentialEnv },
    mindBin,
  };
}

export function buildConditionProfiles(input: BuildProfilesInput): ConditionProfile[] {
  return input.conditions.map(condition =>
    buildConditionProfile(input.runDir, condition, input.worktrees, input.credentialEnv)
  );
}

/** The judge runs in its own no-memory tree with every tool denied. */
export function buildJudgeProfile(
  runDir: string,
  credentialEnv: Record<string, string> = {}
): JudgeProfile {
  const dir = isolationDirs(join(runDir, 'judge'));
  return {
    id: 'judge',
    dirs: dir,
    env: {
      ...buildOpenCodeEnv({
        condition: 'no-memory',
        dir,
        mindBin: null,
        permissions: JUDGE_DENY_ALL,
      }),
      ...credentialEnv,
    },
  };
}

// ── Per-question database isolation ──────────────────────────────────────────

export interface DatabaseCopyResult {
  readonly dbPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Copy an ingested Mind database to a fresh per-question location.
 *
 * Method (deterministic): fold the source WAL into the main file with
 * `PRAGMA wal_checkpoint(TRUNCATE)`, then copy `mind.db`. Any leftover
 * `-wal`/`-shm` siblings are copied too so the copy is never torn. The source
 * DB is the benchmark's own ingested copy, never the user's live database.
 */
export function copyMindDatabaseForQuestion(
  sourceDbPath: string,
  targetDbPath: string
): DatabaseCopyResult {
  if (!existsSync(sourceDbPath)) {
    throw new Error(`source database does not exist: ${sourceDbPath}`);
  }
  mkdirSync(dirname(targetDbPath), { recursive: true });

  const db = new Database(sourceDbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    db.close();
  }

  copyFileSync(sourceDbPath, targetDbPath);
  for (const suffix of ['-wal', '-shm'] as const) {
    if (existsSync(`${sourceDbPath}${suffix}`)) {
      copyFileSync(`${sourceDbPath}${suffix}`, `${targetDbPath}${suffix}`);
    }
  }

  const bytes = Bun.file(targetDbPath).size;
  const sha256 = sha256File(targetDbPath);
  return { dbPath: targetDbPath, bytes, sha256 };
}

export function sha256File(path: string): string {
  const hasher = createHash('sha256');
  hasher.update(readFileSync(path));
  return hasher.digest('hex');
}

/** Remove a copied per-question database (main + WAL/SHM siblings). */
export function removeDatabaseCopy(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(path, { force: true });
  }
}
