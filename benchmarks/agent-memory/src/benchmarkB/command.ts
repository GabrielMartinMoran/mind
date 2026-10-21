// `scenarios` command wiring (benchmark B).
//
// Prepares (or reuses) a run directory, resolves the pinned Mind worktrees for
// the Mind conditions, and runs every selected scenario for every requested
// condition through the process-per-session executor. Every paid prompt is
// charged through a single `BudgetGuard`, and each scenario/condition stage
// status is written to `meta.json`.
//
// The executor, worktrees, database initializer and command runner are all
// injectable, so the whole command dry-runs offline with fakes.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BudgetGuard } from '../budget';
import {
  DATASET,
  DEFAULT_LIMITS,
  MODEL,
  engineForCondition,
  type ConditionId,
  type EngineVersion,
  type PinnedEngineVersion,
} from '../config';
import type { CommandRunner } from '../exec';
import { ensureWorktree } from '../mind/worktree';
import { loadCredentialEnv } from '../opencode/credentials';
import {
  createRunId,
  createRunLayout,
  createRunMeta,
  mergeActiveConditions,
  readRunMeta,
  withStage,
  writeRunMeta,
  type RunMeta,
  type StageStatus,
} from '../run';

import { createProcessSessionExecutor } from './executor';
import {
  runScenarioRun,
  scenarioGateReason,
  scenarioRunStatus,
  type BSessionExecutor,
  type InitMindDbInput,
  type ScenarioAggregate,
  type ScenariosRunResult,
} from './runner';
import type { Scenario } from './scenario';
import { selectScenarios } from './scenarios/registry';

export interface ScenariosCommandOptions {
  /** Explicit run id, or null to generate a fresh run. */
  readonly runId: string | null;
  readonly runsRoot: string;
  readonly workRoot: string;
  readonly conditions: readonly ConditionId[];
  /** Scenario ids to run (empty = all registry scenarios). */
  readonly scenarios: readonly string[];
  /** Hard cost cap; null refuses any positive spend. */
  readonly budgetUsd: number | null;
}

export interface ScenariosCommandDeps {
  readonly repoRoot: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Injectable session executor; defaults to the process-per-session one. */
  readonly executor?: BSessionExecutor;
  /** Pre-resolved worktree paths per engine (tests); otherwise ensured. */
  readonly worktrees?: Partial<Record<EngineVersion, string>>;
  /** Injectable fresh-DB initializer. */
  readonly initMindDb?: (input: InitMindDbInput) => Promise<void>;
  /** Overrides the worker entry path (tests). */
  readonly workerPath?: string;
  /** Overrides the scenario set (tests). */
  readonly scenarios?: readonly Scenario[];
  /**
   * Explicit provider credential env for paid stages. An explicit value
   * (including `{}`) always wins, so tests never touch the auth store.
   */
  readonly credentialEnv?: Record<string, string>;
  /** Overrides the auth store path (tests). */
  readonly authPath?: string;
  readonly now?: Date;
}

/**
 * Resolve the provider credential env exactly like the A2 command: an explicit
 * `credentialEnv` wins; an injected executor means an offline run and never
 * reads `auth.json`; otherwise the authorized key is loaded at runtime.
 */
export function resolveScenariosCredentialEnv(
  deps: Pick<ScenariosCommandDeps, 'credentialEnv' | 'authPath' | 'executor'>
): Record<string, string> {
  if (deps.credentialEnv) return deps.credentialEnv;
  if (deps.executor) return {};
  return loadCredentialEnv(MODEL, { authPath: deps.authPath });
}

const WORKER_RELATIVE = 'benchmarks/agent-memory/src/benchmarkB/worker.ts';
const HARNESS_RELATIVE = 'benchmarks/agent-memory';

interface MetaWriter {
  set(next: RunMeta): void;
  update(stage: string, status: StageStatus, note?: string): void;
}

function initWriter(
  metaPath: string,
  initial: RunMeta
): { writer: MetaWriter; meta: () => RunMeta } {
  let meta = initial;
  return {
    meta: () => meta,
    writer: {
      set: next => {
        meta = next;
        writeRunMeta(metaPath, meta);
      },
      update: (stage, status, note) => {
        meta = withStage(meta, stage, status, note);
        writeRunMeta(metaPath, meta);
      },
    },
  };
}

interface ResolvedWorktrees {
  readonly paths: Partial<Record<EngineVersion, string>>;
  readonly shas: Partial<Record<PinnedEngineVersion, string>>;
}

async function resolveWorktrees(
  deps: ScenariosCommandDeps,
  workRoot: string,
  conditions: readonly ConditionId[]
): Promise<ResolvedWorktrees> {
  const paths: Partial<Record<EngineVersion, string>> = { ...(deps.worktrees ?? {}) };
  const shas: Partial<Record<PinnedEngineVersion, string>> = {};
  for (const condition of conditions) {
    const version = engineForCondition(condition);
    if (version === null || paths[version]) continue;
    if (version === 'current') {
      // The current condition is the local checkout by definition. Fail closed
      // if the expected entry point is not there instead of silently falling
      // back to a pinned commit.
      const mindBin = join(deps.repoRoot, 'mind');
      if (!existsSync(mindBin)) {
        throw new Error(`mind-current requires the local checkout at '${mindBin}'`);
      }
      paths.current = deps.repoRoot;
      continue;
    }
    const info = await ensureWorktree({
      repoRoot: deps.repoRoot,
      workRoot,
      version,
      runner: deps.runner,
    });
    paths[version] = info.path;
    shas[version] = info.sha;
  }
  return { paths, shas };
}

function summarize(aggregates: readonly ScenarioAggregate[]): string {
  return aggregates
    .map(
      aggregate =>
        `${aggregate.condition}: ${aggregate.passed}/${aggregate.scenarios} passed, ` +
        `${aggregate.childSessions} child sessions, $${aggregate.costUsd.toFixed(4)}`
    )
    .join(' | ');
}

export async function runScenariosCommand(
  options: ScenariosCommandOptions,
  deps: ScenariosCommandDeps
): Promise<number> {
  const runsRoot = resolve(deps.repoRoot, options.runsRoot);
  const workRoot = resolve(deps.repoRoot, options.workRoot);

  let scenarios: readonly Scenario[];
  try {
    scenarios = deps.scenarios ?? selectScenarios(options.scenarios);
  } catch (error) {
    deps.stderr(String(error));
    return 2;
  }
  if (scenarios.length === 0) {
    deps.stderr('no scenarios selected');
    return 2;
  }

  // Reuse an existing run (and its meta) when a run id was provided.
  const runId = options.runId ?? createRunId(deps.now);
  const layout = createRunLayout({ runRoot: runsRoot, workRoot }, runId, options.conditions);
  const existingMetaPath = options.runId ? join(runsRoot, options.runId, 'meta.json') : null;
  let meta: RunMeta;
  if (existingMetaPath && existsSync(existingMetaPath)) {
    const existing = readRunMeta(existingMetaPath);
    meta = {
      ...existing,
      activeConditions: mergeActiveConditions(existing.activeConditions, options.conditions),
    };
  } else {
    const limits = { ...DEFAULT_LIMITS, maxCostUsd: options.budgetUsd };
    meta = createRunMeta({
      layout,
      shas: { v9: null, v10: null },
      versions: { opencode: null, sdk: null, bun: Bun.version },
      model: MODEL,
      dataset: { url: DATASET.url, sha256: null },
      subset: { seed: 0, count: 0, conversation: '' },
      limits,
      budget: { maxCostUsd: options.budgetUsd, spentUsd: 0 },
      activeConditions: options.conditions,
      now: deps.now,
    });
  }

  const runDir = join(runsRoot, runId);
  const metaPath = join(runDir, 'meta.json');
  const { writer, meta: currentMeta } = initWriter(metaPath, meta);
  writer.set(meta);

  const budget = new BudgetGuard({ maxCostUsd: options.budgetUsd });

  let credentialEnv: Record<string, string>;
  try {
    credentialEnv = resolveScenariosCredentialEnv(deps);
  } catch (error) {
    writer.update('scenarios:start', 'failed', String(error));
    deps.stderr(`scenarios: credential loading failed: ${String(error)}`);
    return 1;
  }

  // Prepare a condition's worktree only when at least one selected scenario can
  // actually run there. Gated scenarios still appear as `not_run` in the results.
  const conditionsToPrepare = options.conditions.filter(condition =>
    scenarios.some(scenario => scenarioGateReason(scenario, condition, credentialEnv) === null)
  );

  let worktrees: Partial<Record<EngineVersion, string>>;
  try {
    const resolved = await resolveWorktrees(deps, workRoot, conditionsToPrepare);
    worktrees = resolved.paths;
    if (resolved.shas.v9 || resolved.shas.v10) {
      writer.set({
        ...meta,
        shas: {
          v9: resolved.shas.v9 ?? meta.shas.v9,
          v10: resolved.shas.v10 ?? meta.shas.v10,
        },
      });
    }
  } catch (error) {
    writer.update('scenarios:start', 'failed', String(error));
    deps.stderr(`scenarios: worktree preparation failed: ${String(error)}`);
    return 1;
  }

  const executor =
    deps.executor ??
    createProcessSessionExecutor({
      runner: deps.runner,
      workerPath: deps.workerPath ?? join(deps.repoRoot, WORKER_RELATIVE),
    });

  writer.update('scenarios:start', 'running');
  deps.stdout(
    `scenarios run ${runId}: conditions=${options.conditions.join(',')} ` +
      `scenarios=${scenarios.map(scenario => scenario.id).join(',')}`
  );

  let run: ScenariosRunResult;
  try {
    run = await runScenarioRun(
      {
        runId,
        runDir,
        conditions: options.conditions,
        scenarios,
        limits: { steps: meta.limits.sessionSteps, timeoutMs: meta.limits.timeoutMs },
        budget,
        stdout: deps.stdout,
        stderr: deps.stderr,
        credentialEnv,
      },
      {
        fixtureDirFor: scenario => join(deps.repoRoot, HARNESS_RELATIVE, scenario.fixture),
        worktrees,
        executor,
        initMindDb: deps.initMindDb,
        runner: deps.runner,
      }
    );
  } catch (error) {
    writer.update('scenarios:start', 'failed', String(error));
    deps.stderr(`scenarios failed: ${String(error)}`);
    return 1;
  }

  for (const result of run.results) {
    const status = scenarioRunStatus(result);
    writer.update(
      `scenarios:${result.scenarioId}:${result.condition}`,
      status === 'not_run' ? 'skipped' : status,
      status === 'not_run'
        ? (result.notRunReason ?? 'not run')
        : `${result.sessions.length} sessions, ${result.childCount} children`
    );
  }
  writer.set({
    ...currentMeta(),
    budget: { maxCostUsd: options.budgetUsd, spentUsd: run.spentUsd },
  });
  writer.update('scenarios:start', 'passed');

  deps.stdout(`scenarios ${summarize(run.aggregates)}`);
  deps.stdout(`scenarios spent $${run.spentUsd.toFixed(4)}`);
  return 0;
}
