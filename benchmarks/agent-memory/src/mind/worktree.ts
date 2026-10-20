// Pinned Mind worktrees.
//
// Each engine version runs its OWN code from a detached git worktree at the
// pinned commit. This module ensures those worktrees exist (idempotently),
// installs their dependencies once, and can prove the engine's real SQLite
// schema version.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { PINNED_VERSIONS, type EngineVersion } from '../config';
import { runCommand, type CommandRunner } from '../exec';

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeInfo {
  readonly version: EngineVersion;
  readonly path: string;
  readonly sha: string;
  readonly created: boolean;
}

export interface SchemaInfo {
  readonly schemaVersion: number;
  readonly hasTrigram: boolean;
}

export function worktreesDir(workRoot: string): string {
  return join(workRoot, 'worktrees');
}

export function worktreePath(workRoot: string, version: EngineVersion): string {
  return join(worktreesDir(workRoot), version);
}

export interface EnsureWorktreeOptions {
  readonly repoRoot: string;
  readonly workRoot: string;
  readonly version: EngineVersion;
  readonly runner?: CommandRunner;
}

export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<WorktreeInfo> {
  const runner = options.runner ?? runCommand;
  if (options.version === 'current') {
    throw new WorktreeError(
      "condition 'mind-current' runs the local checkout; no pinned worktree is created"
    );
  }
  const pinned = PINNED_VERSIONS[options.version];
  const path = worktreePath(options.workRoot, options.version);
  const gitMarker = join(path, '.git');

  let created = false;
  if (!existsSync(gitMarker)) {
    mkdirSync(worktreesDir(options.workRoot), { recursive: true });
    const add = await runner({
      command: 'git',
      args: ['-C', options.repoRoot, 'worktree', 'add', '--detach', path, pinned.ref],
    });
    if (add.exitCode !== 0) {
      throw new WorktreeError(
        `git worktree add failed for ${options.version} (${pinned.ref}): ${add.stderr.trim()}`
      );
    }
    created = true;
  }

  const head = await runner({ command: 'git', args: ['-C', path, 'rev-parse', 'HEAD'] });
  if (head.exitCode !== 0) {
    throw new WorktreeError(`cannot resolve HEAD for ${options.version}: ${head.stderr.trim()}`);
  }
  const sha = head.stdout.trim();
  if (!sha.startsWith(pinned.ref)) {
    throw new WorktreeError(
      `worktree ${options.version} is at ${sha}, expected pinned ref ${pinned.ref}`
    );
  }

  if (!existsSync(join(path, 'node_modules'))) {
    const install = await runner({ command: 'bun', args: ['install'], cwd: path });
    if (install.exitCode !== 0) {
      throw new WorktreeError(
        `bun install failed for ${options.version}: ${install.stderr.trim()}`
      );
    }
  }

  return { version: options.version, path, sha, created };
}

export function readSchemaInfo(dbPath: string): SchemaInfo {
  const db = new Database(dbPath, { readonly: true });
  try {
    const version = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string | number }
      | undefined;
    const trigram = db
      .query('SELECT name FROM sqlite_master WHERE name = ?')
      .get('memories_fts_trigram') as { name: string } | undefined;
    return {
      schemaVersion: Number(version?.value ?? -1),
      hasTrigram: Boolean(trigram),
    };
  } finally {
    db.close();
  }
}

export interface ProbeSchemaOptions {
  readonly worktreePath: string;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly runner?: CommandRunner;
}

// Initialise a fresh database through the pinned engine's own CLI, then read
// the real schema. `MIND_DATA_DIR` auto-creates its parent; `MIND_DB_PATH`
// requires the parent to exist, so we create `dataDir` first.
export async function probeSchema(options: ProbeSchemaOptions): Promise<SchemaInfo> {
  const runner = options.runner ?? runCommand;
  mkdirSync(options.dataDir, { recursive: true });
  const status = await runner({
    command: join(options.worktreePath, 'mind'),
    args: ['status'],
    env: {
      ...process.env,
      MIND_DATA_DIR: options.dataDir,
      MIND_DB_PATH: options.dbPath,
      MIND_SYNC_ROOT: join(options.dataDir, 'syncroot'),
      MIND_RAG: 'false',
    },
  });
  if (status.exitCode !== 0) {
    throw new WorktreeError(`mind status failed: ${status.stderr.trim() || status.stdout.trim()}`);
  }
  return readSchemaInfo(options.dbPath);
}
