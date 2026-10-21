// Paid A2 command wiring: `locomo --answers` (A2 answering + blind judge) and
// `locomo --judge-only --run-id <id>` (re-judge stored answers).
//
// Both paths operate on a run directory previously produced by the FREE
// `locomo` command (it contains `meta.json`, `subset.json`, the per-condition
// ingested databases and the A1 results). Every paid prompt is charged through
// a single `BudgetGuard`, and every stage status is written to `meta.json`.
//
// The executor (A2 answering) and the judge driver are injectable so the whole
// command can be exercised offline with fakes; the real entry point wires the
// process executor and the SDK driver.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BudgetGuard } from '../budget';
import { MODEL, engineForCondition, type ConditionId, type EngineVersion } from '../config';
import type { CommandRunner } from '../exec';
import { ensureIsolationDirs } from '../isolation/opencode';
import { DEFAULT_SEED, type SubsetItem } from '../locomo/subset';
import { worktreePath } from '../mind/worktree';
import {
  buildConditionProfiles,
  buildJudgeProfile,
  type ConditionProfile,
} from '../opencode/conditions';
import { loadCredentialEnv } from '../opencode/credentials';
import type { SessionDriver } from '../opencode/driver';
import { createProcessExecutor } from '../opencode/executor';
import {
  mergeActiveConditions,
  readRunMeta,
  withStage,
  writeRunMeta,
  type RunMeta,
  type StageStatus,
} from '../run';
import { captureToolVersions } from '../versions';

import { runA2, type A2UnitExecutor } from './a2';
import {
  aggregateCondition,
  buildBlindPayloads,
  questionRepRows,
  measurementKey,
  runBlindJudge,
  verdictForCondition,
  type A2QuestionResult,
  type BlindPayload,
  type ConditionAggregate,
  type QuestionCandidates,
} from './judge';

export interface A2CommandOptions {
  /** Prepared run id (required: A2 consumes an existing free `locomo` run). */
  readonly runId: string;
  readonly runsRoot: string;
  readonly workRoot: string;
  readonly conditions: readonly ConditionId[];
  readonly budgetUsd: number | null;
  /** Independent repetitions per (condition, question). Default 1. */
  readonly reps?: number;
  /** Re-judge stored answers only; skip the paid answering stage. */
  readonly judgeOnly: boolean;
}

export interface A2CommandDeps {
  readonly repoRoot: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Injectable A2 measuring executor; defaults to the process-per-unit one. */
  readonly executor?: A2UnitExecutor;
  /** Injectable judge driver; defaults to the real SDK driver. */
  readonly judgeDriver?: SessionDriver;
  /** Overrides the worker entry path (tests); defaults to the repo worker. */
  readonly workerPath?: string;
  /** Overrides the judge profile env/workspace (tests). */
  readonly judgeProfile?: { readonly workspaceDir: string; readonly env: Record<string, string> };
  /**
   * Explicit provider credential env for paid stages. When omitted and the
   * real executor is used, the authorized key is loaded from OpenCode's
   * `auth.json` into the isolated child environment only.
   */
  readonly credentialEnv?: Record<string, string>;
  /** Overrides the auth store path (tests). */
  readonly authPath?: string;
}

const WORKER_RELATIVE = 'benchmarks/agent-memory/src/opencode/worker.ts';

/**
 * Return a copy of `meta` with `addedUsd` accumulated into `budget.spentUsd`.
 * Costs are additive (A2 + judge) so a re-run never loses an earlier stage's
 * spend. `maxCostUsd` is only overwritten when a cap is provided.
 */
export function withBudgetSpent(
  meta: RunMeta,
  maxCostUsd: number | null,
  addedUsd: number
): RunMeta {
  const current = meta.budget?.spentUsd ?? 0;
  return {
    ...meta,
    budget: {
      maxCostUsd: maxCostUsd ?? meta.budget?.maxCostUsd ?? null,
      spentUsd: current + addedUsd,
    },
  };
}

/** Accumulates stage statuses into a single `meta.json`. */
interface MetaWriter {
  set(next: RunMeta): void;
  update(stage: string, status: StageStatus, note?: string): void;
}

function workerPathFor(repoRoot: string): string {
  return join(repoRoot, WORKER_RELATIVE);
}

function readSubset(runDir: string): SubsetItem[] {
  const path = join(runDir, 'subset.json');
  if (!existsSync(path)) {
    throw new Error(`subset.json not found in run '${runDir}' (run the free locomo stage first)`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: SubsetItem[] };
  return parsed.items ?? (parsed as unknown as SubsetItem[]);
}

/** Group per-condition answers into one candidate set per (question, rep). */
export function groupCandidates(
  results: readonly A2QuestionResult[],
  subset: readonly SubsetItem[]
): QuestionCandidates[] {
  const byKey = new Map<string, A2QuestionResult[]>();
  for (const result of results) {
    const key = measurementKey(result);
    const list = byKey.get(key) ?? [];
    list.push(result);
    byKey.set(key, list);
  }
  const questions: QuestionCandidates[] = [];
  for (const item of subset) {
    const repIndexes = new Set(
      results.filter(result => result.id === item.id).map(result => result.rep ?? 0)
    );
    if (repIndexes.size === 0) repIndexes.add(0);
    for (const rep of [...repIndexes].sort((a, b) => a - b)) {
      const key = `${item.id}::rep${rep}`;
      const group = byKey.get(key);
      if (!group || group.length === 0) continue;
      questions.push({
        id: item.id,
        key,
        rep,
        question: item.question,
        reference: item.answer,
        adversarial: item.adversarial,
        candidates: group.map(result => ({ condition: result.condition, text: result.answer })),
      });
    }
  }
  return questions;
}

export interface JudgeStageResult {
  readonly results: readonly A2QuestionResult[];
  readonly aggregates: readonly ConditionAggregate[];
  readonly manualQueue: readonly string[];
  readonly promptCount: number;
  readonly costUsd: number;
}

export interface JudgeStageDeps {
  readonly driver: SessionDriver;
  readonly workspaceDir: string;
  readonly limits: { readonly steps: number; readonly timeoutMs: number };
  readonly seed?: number;
}

/**
 * Run the blind judge for a set of per-condition results and map the verdicts
 * back to each condition using the payload order (which stays out of the
 * prompt). Results are returned with their `judge` field populated.
 */
export async function runJudgeStage(
  results: readonly A2QuestionResult[],
  subset: readonly SubsetItem[],
  deps: JudgeStageDeps
): Promise<JudgeStageResult> {
  const questions = groupCandidates(results, subset);
  const payloads = buildBlindPayloads(questions, deps.seed ?? DEFAULT_SEED);
  const orderById = new Map<string, readonly ConditionId[]>(
    payloads.map((payload: BlindPayload) => [payload.id, payload.order])
  );

  const judge = await runBlindJudge(payloads, {
    driver: deps.driver,
    workspaceDir: deps.workspaceDir,
    limits: deps.limits,
  });

  const judged = results.map(result => {
    const key = measurementKey(result);
    const order = orderById.get(key);
    const verdicts = judge.verdicts[key];
    if (!order || !verdicts) return result;
    return { ...result, judge: verdictForCondition(verdicts, order, result.condition) };
  });

  const conditions = [...new Set(judged.map(result => result.condition))];
  const aggregates = conditions.map(condition =>
    aggregateCondition(
      condition,
      judged.filter(result => result.condition === condition)
    )
  );

  return {
    results: judged,
    aggregates,
    manualQueue: judge.manualQueue,
    promptCount: judge.promptCount,
    costUsd: judge.costUsd,
  };
}

function writeResults(
  runDir: string,
  results: readonly A2QuestionResult[],
  aggregates: readonly ConditionAggregate[]
): void {
  const resultsDir = join(runDir, 'results');
  const byCondition = new Map<ConditionId, A2QuestionResult[]>();
  for (const result of results) {
    const list = byCondition.get(result.condition) ?? [];
    list.push(result);
    byCondition.set(result.condition, list);
  }
  for (const [condition, list] of byCondition) {
    writeFileSync(
      join(resultsDir, `a2-${condition}.json`),
      `${JSON.stringify(list, null, 2)}\n`,
      'utf8'
    );
    writeFileSync(
      join(resultsDir, `a2-${condition}-means.json`),
      `${JSON.stringify(questionRepRows(list), null, 2)}\n`,
      'utf8'
    );
  }
  // Preserve the top-level fields the answering stage wrote (temperature,
  // reps) when the judge stage rewrites the aggregates file.
  let existing: Record<string, unknown> = {};
  const aggregatesPath = join(resultsDir, 'a2-aggregates.json');
  if (existsSync(aggregatesPath)) {
    try {
      existing = JSON.parse(readFileSync(aggregatesPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  writeFileSync(
    aggregatesPath,
    `${JSON.stringify({ ...existing, aggregates }, null, 2)}\n`,
    'utf8'
  );
}

/** Read the stored `a2-<condition>.json` results for a prepared run. */
export function readStoredResults(
  runDir: string,
  conditions: readonly ConditionId[]
): A2QuestionResult[] {
  const out: A2QuestionResult[] = [];
  for (const condition of conditions) {
    const path = join(runDir, 'results', `a2-${condition}.json`);
    if (!existsSync(path)) {
      throw new Error(`no stored answers for condition '${condition}' in run '${runDir}'`);
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as A2QuestionResult[];
    out.push(...parsed);
  }
  return out;
}

export function resolveWorktrees(
  repoRoot: string,
  workRoot: string,
  conditions: readonly ConditionId[]
): Partial<Record<EngineVersion, string>> {
  const worktrees: Partial<Record<EngineVersion, string>> = {};
  for (const condition of conditions) {
    const version = engineForCondition(condition);
    if (version === null) continue;
    if (version === 'current') {
      const mindBin = join(repoRoot, 'mind');
      if (!existsSync(mindBin)) {
        throw new Error(`mind-current requires the local checkout at '${mindBin}'`);
      }
      worktrees.current = repoRoot;
      continue;
    }
    worktrees[version] = worktreePath(workRoot, version);
  }
  return worktrees;
}

function sourceDatabases(
  runDir: string,
  conditions: readonly ConditionId[]
): Partial<Record<ConditionId, string>> {
  const sources: Partial<Record<ConditionId, string>> = {};
  for (const condition of conditions) {
    if (engineForCondition(condition) === null) continue;
    const db = join(runDir, condition, 'mind.db');
    if (existsSync(db)) sources[condition] = db;
  }
  return sources;
}

/** Mind conditions whose ingested database is missing from a prepared run. */
export function missingPreparedDatabases(
  runDir: string,
  conditions: readonly ConditionId[]
): ConditionId[] {
  return conditions.filter(
    condition =>
      engineForCondition(condition) !== null && !existsSync(join(runDir, condition, 'mind.db'))
  );
}

/**
 * Resolve the provider credential env for paid stages. An explicit
 * `deps.credentialEnv` (including `{}`) always wins, so tests never touch the
 * auth store; otherwise a real run loads the authorized key at runtime.
 */
function resolveCredentialEnv(deps: A2CommandDeps): Record<string, string> {
  if (deps.credentialEnv) return deps.credentialEnv;
  if (deps.executor || deps.judgeDriver) return {};
  return loadCredentialEnv(MODEL, { authPath: deps.authPath });
}

interface JudgeContext {
  readonly runDir: string;
  readonly subset: readonly SubsetItem[];
  readonly budget: BudgetGuard;
  readonly writer: MetaWriter;
}

/**
 * Entry point for the paid A2 stages. Assumes the run already passed the
 * `--budget`/`--confirm` gate in the dispatcher; refuses when the run has no
 * prepared artifacts.
 */
export async function runA2Command(
  options: A2CommandOptions,
  deps: A2CommandDeps
): Promise<number> {
  const runsRoot = resolve(deps.repoRoot, options.runsRoot);
  const workRoot = resolve(deps.repoRoot, options.workRoot);
  const runDir = join(runsRoot, options.runId);
  if (!existsSync(runDir)) {
    deps.stderr(
      `run '${options.runId}' not found under ${runsRoot}; run the free locomo stage first`
    );
    return 1;
  }

  const metaPath = join(runDir, 'meta.json');
  if (!existsSync(metaPath)) {
    deps.stderr(`run '${options.runId}' has no meta.json; run the free locomo stage first`);
    return 1;
  }
  let meta = readRunMeta(metaPath);
  meta = {
    ...meta,
    activeConditions: mergeActiveConditions(meta.activeConditions, options.conditions),
  };
  const writer: MetaWriter = {
    set: next => {
      meta = next;
      writeRunMeta(metaPath, meta);
    },
    update: (stage, status, note) => {
      meta = withStage(meta, stage, status, note);
      writeRunMeta(metaPath, meta);
    },
  };

  // Backfill tool versions on a run prepared before version capture existed
  // (e.g. the T7b pilot), so the report never shows `n/a` for OpenCode/SDK.
  const existingVersions = meta.versions ?? { opencode: null, sdk: null, bun: null };
  if (existingVersions.opencode === null || existingVersions.sdk === null) {
    const versions = await captureToolVersions(deps.runner, { repoRoot: deps.repoRoot }).catch(
      () => null
    );
    if (versions) {
      writer.set({
        ...meta,
        versions: {
          opencode: versions.opencode ?? existingVersions.opencode,
          sdk: versions.sdk ?? existingVersions.sdk,
          bun: versions.bun ?? existingVersions.bun,
        },
      });
    }
  }

  let subset: SubsetItem[];
  try {
    subset = readSubset(runDir);
  } catch (error) {
    deps.stderr(String(error));
    return 1;
  }

  // A2 answers from an ingested database. A Mind condition without one must
  // never run with a null DB: fail closed with the actionable missing list.
  if (!options.judgeOnly) {
    const missing = missingPreparedDatabases(runDir, options.conditions);
    if (missing.length > 0) {
      const message =
        `a2: missing prepared Mind database(s) for ${missing.join(', ')}; run the free ` +
        `locomo A1 stage with the same conditions first (locomo --conditions ` +
        `${options.conditions.join(',')}).`;
      writer.update('a2:start', 'failed', message);
      deps.stderr(message);
      return 1;
    }
  }

  const budget = new BudgetGuard({ maxCostUsd: options.budgetUsd });
  const ctx: JudgeContext = { runDir, subset, budget, writer };

  if (options.judgeOnly) {
    return runJudgeOnly(options, deps, ctx);
  }

  let worktrees: Partial<Record<EngineVersion, string>>;
  try {
    worktrees = resolveWorktrees(deps.repoRoot, workRoot, options.conditions);
  } catch (error) {
    writer.update('a2:start', 'failed', String(error));
    deps.stderr(`a2: worktree preparation failed: ${String(error)}`);
    return 1;
  }

  const profiles = buildConditionProfiles({
    runDir,
    conditions: options.conditions,
    worktrees,
    credentialEnv: resolveCredentialEnv(deps),
  });
  const profileMap: Partial<Record<ConditionId, ConditionProfile>> = {};
  for (const profile of profiles) profileMap[profile.id] = profile;

  const executor =
    deps.executor ??
    createProcessExecutor({
      runner: deps.runner,
      workerPath: deps.workerPath ?? workerPathFor(deps.repoRoot),
    });

  writer.update('a2:start', 'running');
  deps.stdout(
    `a2 run ${options.runId}: conditions=${options.conditions.join(',')} reps=${options.reps ?? 1}`
  );

  let spentUsd: number;
  try {
    const a2 = await runA2(
      {
        runId: options.runId,
        runDir,
        conditions: options.conditions,
        subset,
        limits: { steps: meta.limits.sessionSteps, timeoutMs: meta.limits.timeoutMs },
        reps: options.reps ?? 1,
        budget,
        stdout: deps.stdout,
        stderr: deps.stderr,
      },
      {
        profiles: profileMap,
        sourceDb: sourceDatabases(runDir, options.conditions),
        executor,
      }
    );
    for (const aggregate of a2.aggregates) {
      writer.update(`a2:${aggregate.condition}`, 'passed', `${aggregate.count} questions`);
    }
    writer.set(withBudgetSpent(meta, options.budgetUsd, a2.spentUsd));
    writer.update('a2:start', 'passed', `$${a2.spentUsd.toFixed(4)}`);
    spentUsd = a2.spentUsd;
  } catch (error) {
    writer.update('a2:start', 'failed', String(error));
    deps.stderr(`a2 failed: ${String(error)}`);
    return 1;
  }
  deps.stdout(`a2 spent $${spentUsd.toFixed(4)}`);

  return runJudgeOnly(options, deps, ctx);
}

async function runJudgeOnly(
  options: A2CommandOptions,
  deps: A2CommandDeps,
  ctx: JudgeContext
): Promise<number> {
  let results: A2QuestionResult[];
  try {
    results = readStoredResults(ctx.runDir, options.conditions);
  } catch (error) {
    deps.stderr(String(error));
    return 1;
  }
  if (results.length === 0) {
    deps.stderr(`no stored answers to judge in run '${options.runId}'`);
    return 1;
  }

  const judgeProfile = resolveJudgeTarget(deps, ctx.runDir);
  ctx.writer.update('judge:start', 'running');

  const driver = deps.judgeDriver ?? (await createDefaultJudgeDriver(judgeProfile.env));

  let stage: JudgeStageResult;
  try {
    stage = await runJudgeStage(results, ctx.subset, {
      driver,
      workspaceDir: judgeProfile.workspaceDir,
      limits: { steps: 1, timeoutMs: 120_000 },
    });
    ctx.budget.addCost(stage.costUsd, `judge:${options.runId}`);
  } catch (error) {
    ctx.writer.update('judge:start', 'failed', String(error));
    deps.stderr(`judge failed: ${String(error)}`);
    return 1;
  } finally {
    await driver.close().catch(() => undefined);
  }

  writeResults(ctx.runDir, stage.results, stage.aggregates);
  writeFileSync(
    join(ctx.runDir, 'results', 'judge-manual-queue.json'),
    `${JSON.stringify(stage.manualQueue, null, 2)}\n`,
    'utf8'
  );
  // Accumulate the judge spend onto whatever the run already recorded (A2 and
  // any earlier stages), reading the latest meta so nothing is lost.
  const latest = readRunMeta(join(ctx.runDir, 'meta.json'));
  ctx.writer.set(withBudgetSpent(latest, options.budgetUsd, stage.costUsd));
  const note = `${stage.promptCount} prompts, $${stage.costUsd.toFixed(4)}, ${stage.manualQueue.length} manual`;
  ctx.writer.update('judge:start', 'passed', note);
  deps.stdout(
    `judge: ${stage.promptCount} prompts, $${stage.costUsd.toFixed(4)}, ` +
      `manual=${stage.manualQueue.length}`
  );
  return 0;
}

async function createDefaultJudgeDriver(env: Record<string, string>): Promise<SessionDriver> {
  const { createSdkDriver } = await import('../opencode/driver');
  return createSdkDriver({ env });
}

/** Resolve the judge workspace + isolated env, from an override or the run dir. */
function resolveJudgeTarget(
  deps: A2CommandDeps,
  runDir: string
): { readonly workspaceDir: string; readonly env: Record<string, string> } {
  if (deps.judgeProfile) return deps.judgeProfile;
  const profile = buildJudgeProfile(runDir, resolveCredentialEnv(deps));
  ensureIsolationDirs(profile.dirs);
  return { workspaceDir: profile.dirs.workspace, env: profile.env };
}
