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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConditionId, Limits, ModelRef } from './config';

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

export interface RunStage {
  readonly status: StageStatus;
  readonly updatedAt: string;
  readonly note?: string;
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
  readonly stages: Record<string, RunStage>;
  readonly artifacts: {
    readonly root: string;
    readonly results: string;
    readonly conditions: Record<ConditionId, string>;
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
  readonly stages?: Record<string, RunStage>;
  readonly now?: Date;
}

export function createRunMeta(input: CreateRunMetaInput): RunMeta {
  const nowIso = (input.now ?? new Date()).toISOString();
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
    stages: input.stages ?? {},
    artifacts: {
      root: input.layout.runDir,
      results: input.layout.resultsDir,
      conditions: Object.fromEntries(
        Object.entries(input.layout.conditions).map(([k, v]) => [k, v.dir])
      ) as Record<ConditionId, string>,
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
