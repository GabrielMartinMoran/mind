// Run identity, on-disk layout, and `meta.json` read/write.
//
// Every benchmark run gets a unique id and a dedicated directory tree:
//
//   <runRoot>/<runId>/
//     meta.json
//     results/
//     <condition>/            (no-memory | mind-v9 | mind-v10)
//       opencode/             (isolated HOME + XDG dirs + opencode.db)
//       workspace/            (fresh agent cwd)
//
// The run metadata records everything needed to reproduce a run: pinned SHAs,
// tool versions, model, dataset hash, subset seed/count, limits, budget and per
// stage status.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONDITIONS,
  RAG_EMBEDDING_PROVIDER,
  type ConditionId,
  type EmbeddingProviderId,
  type Limits,
  type ModelRef,
} from './config';
import { readSchemaInfo } from './mind/worktree';

export type StageStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'contaminated'
  | 'skipped';

export interface ToolVersions {
  readonly opencode: string | null;
  readonly sdk: string | null;
  readonly bun: string | null;
}

export interface PinnedShas {
  readonly v9: string | null;
  readonly v10: string | null;
}

/**
 * Reproducible identity of the invoking checkout, recorded for `mind-current`
 * runs. Every field is best-effort: a missing git/package/schema signal is
 * `null` instead of failing the run.
 */
export interface CheckoutProvenance {
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly dirty: boolean | null;
  readonly packageVersion: string | null;
  readonly schemaVersion: number | null;
  readonly mindBinary: string | null;
}

export interface GitProbeResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type GitProbe = (args: readonly string[], cwd: string) => GitProbeResult;

export interface ProvenanceOptions {
  /** Prepared current database whose schema version should be recorded. */
  readonly dbPath?: string | null;
}

export interface ProvenanceDeps {
  readonly git?: GitProbe;
  readonly readTextFile?: (path: string) => string | null;
  readonly readSchema?: (dbPath: string) => { readonly schemaVersion: number } | null;
  readonly exists?: (path: string) => boolean;
}

export interface RunStage {
  readonly status: StageStatus;
  readonly updatedAt: string;
  readonly note?: string;
}

/** Run-level embeddings mode, recorded so a stored run is self-describing. */
export interface RagMeta {
  readonly enabled: boolean;
  readonly provider: EmbeddingProviderId | null;
}

/** The metadata fragment for a run-level RAG switch. */
export function ragMeta(enabled: boolean): RagMeta {
  return enabled
    ? { enabled: true, provider: RAG_EMBEDDING_PROVIDER }
    : { enabled: false, provider: null };
}

export interface RunMeta {
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly shas: PinnedShas;
  readonly versions: ToolVersions;
  readonly model: ModelRef;
  readonly dataset: { readonly url: string; readonly sha256: string | null };
  readonly subset: { readonly seed: number; readonly count: number; readonly conversation: string };
  readonly limits: Limits;
  readonly budget: { readonly maxCostUsd: number | null; readonly spentUsd: number };
  /** Run-level embeddings mode (absent on runs created before this field). */
  readonly rag?: RagMeta;
  readonly stages: Record<string, RunStage>;
  /** Conditions that actually ran in this run, in canonical order. */
  readonly activeConditions?: readonly ConditionId[];
  /** Reproducible identity of the invoking checkout (current condition only). */
  readonly current?: CheckoutProvenance;
  readonly artifacts: {
    readonly root: string;
    readonly results: string;
    /** Only the selected conditions exist; the map is intentionally partial. */
    readonly conditions: Partial<Record<ConditionId, string>>;
  };
}

export interface ConditionLayout {
  readonly condition: ConditionId;
  readonly dir: string;
  readonly opencodeDir: string;
  readonly workspaceDir: string;
}

export interface RunLayout {
  readonly runId: string;
  readonly runDir: string;
  readonly resultsDir: string;
  readonly metaPath: string;
  readonly conditions: Record<ConditionId, ConditionLayout>;
}

export interface BenchmarkPaths {
  readonly runRoot: string;
  readonly workRoot: string;
}

export function conditionDirName(condition: ConditionId): string {
  return condition;
}

export function runDir(root: string, runId: string): string {
  return join(root, runId);
}

/** Union conditions across stages, in the canonical `CONDITIONS` order. */
export function mergeActiveConditions(
  existing: readonly ConditionId[] | undefined,
  added: readonly ConditionId[]
): ConditionId[] {
  const selected = new Set<ConditionId>([...(existing ?? []), ...added]);
  return CONDITIONS.filter(condition => selected.has(condition));
}

function defaultGitProbe(args: readonly string[], cwd: string): GitProbeResult {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: result.stdout.toString(),
    exitCode: result.exitCode ?? -1,
  };
}

function defaultReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadSchema(dbPath: string): { readonly schemaVersion: number } | null {
  try {
    return readSchemaInfo(dbPath);
  } catch {
    return null;
  }
}

function readPackageVersion(
  repoRoot: string,
  readTextFile: (path: string) => string | null
): string | null {
  const text = readTextFile(join(repoRoot, 'package.json'));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Read the checkout identity recorded for a `mind-current` run. Git output is
 * not parsed as JSON; a command failure records `null` rather than aborting.
 */
export function readCheckoutProvenance(
  repoRoot: string,
  options: ProvenanceOptions = {},
  deps: ProvenanceDeps = {}
): CheckoutProvenance {
  const git = deps.git ?? defaultGitProbe;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const readSchema = deps.readSchema ?? defaultReadSchema;
  const exists = deps.exists ?? existsSync;

  const readGitLine = (args: readonly string[]): string | null => {
    const result = git(args, repoRoot);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  };

  const status = git(['status', '--porcelain'], repoRoot);
  const dirty = status.exitCode === 0 ? status.stdout.trim().length > 0 : null;
  const schemaVersion =
    options.dbPath && exists(options.dbPath)
      ? (readSchema(options.dbPath)?.schemaVersion ?? null)
      : null;
  const mindBinary = join(repoRoot, 'mind');

  return {
    branch: readGitLine(['rev-parse', '--abbrev-ref', 'HEAD']),
    headSha: readGitLine(['rev-parse', 'HEAD']),
    dirty,
    packageVersion: readPackageVersion(repoRoot, readTextFile),
    schemaVersion,
    mindBinary: exists(mindBinary) ? mindBinary : null,
  };
}

// `run-YYYYMMDD-HHMMSS-<4hex>`; time and randomness are injectable for tests.
export function createRunId(
  now: Date = new Date(),
  randomHex: () => string = () => randomBytes(2).toString('hex')
): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `run-${stamp}-${randomHex()}`;
}

export function createRunLayout(
  paths: BenchmarkPaths,
  runId: string,
  conditions: readonly ConditionId[]
): RunLayout {
  const dir = runDir(paths.runRoot, runId);
  const resultsDir = join(dir, 'results');
  mkdirSync(resultsDir, { recursive: true });

  const conditionsLayout = {} as Record<ConditionId, ConditionLayout>;
  for (const condition of conditions) {
    const cdir = join(dir, condition);
    const opencodeDir = join(cdir, 'opencode');
    const workspaceDir = join(cdir, 'workspace');
    mkdirSync(opencodeDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    conditionsLayout[condition] = { condition, dir: cdir, opencodeDir, workspaceDir };
  }

  return {
    runId,
    runDir: dir,
    resultsDir,
    metaPath: join(dir, 'meta.json'),
    conditions: conditionsLayout,
  };
}

export interface CreateRunMetaInput {
  readonly layout: RunLayout;
  readonly shas: PinnedShas;
  readonly versions: ToolVersions;
  readonly model: ModelRef;
  readonly dataset: { readonly url: string; readonly sha256: string | null };
  readonly subset: { readonly seed: number; readonly count: number; readonly conversation: string };
  readonly limits: Limits;
  readonly budget: { readonly maxCostUsd: number | null; readonly spentUsd: number };
  /** Run-level embeddings mode; defaults to disabled. */
  readonly rag?: RagMeta;
  readonly stages?: Record<string, RunStage>;
  /** Defaults to the conditions present in the layout. */
  readonly activeConditions?: readonly ConditionId[];
  readonly current?: CheckoutProvenance;
  readonly now?: Date;
}

export function createRunMeta(input: CreateRunMetaInput): RunMeta {
  const nowIso = (input.now ?? new Date()).toISOString();
  const layoutConditions = Object.keys(input.layout.conditions) as ConditionId[];
  return {
    runId: input.layout.runId,
    createdAt: nowIso,
    updatedAt: nowIso,
    shas: input.shas,
    versions: input.versions,
    model: input.model,
    dataset: input.dataset,
    subset: input.subset,
    limits: input.limits,
    budget: input.budget,
    rag: input.rag ?? ragMeta(false),
    stages: input.stages ?? {},
    activeConditions: [...(input.activeConditions ?? layoutConditions)],
    ...(input.current ? { current: input.current } : {}),
    artifacts: {
      root: input.layout.runDir,
      results: input.layout.resultsDir,
      conditions: Object.fromEntries(
        Object.entries(input.layout.conditions).map(([k, v]) => [k, v.dir])
      ) as Partial<Record<ConditionId, string>>,
    },
  };
}

export function writeRunMeta(metaPath: string, meta: RunMeta): void {
  const next: RunMeta = { ...meta, updatedAt: new Date().toISOString() };
  writeFileSync(metaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function readRunMeta(metaPath: string): RunMeta {
  return JSON.parse(readFileSync(metaPath, 'utf8')) as RunMeta;
}

export function withStage(
  meta: RunMeta,
  stage: string,
  status: StageStatus,
  note?: string
): RunMeta {
  return {
    ...meta,
    stages: {
      ...meta.stages,
      [stage]: { status, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) },
    },
  };
}
