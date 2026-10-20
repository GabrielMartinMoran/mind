// Benchmark B — scenario lifecycle runner.
//
// For every (scenario × condition) the runner:
//   1. prepares a fresh unit directory with its own isolated OpenCode tree;
//   2. for Mind conditions, initializes a FRESH EMPTY database (no ingestion —
//      the agent populates it through MCP if it chooses);
//   3. copies the scenario fixture into the unit workspace;
//   4. runs the scenario sessions SEQUENTIALLY, one new session (and one worker
//      process) per session, with the same isolated env for the whole unit;
//   5. captures the final text, tool/memory calls, tokens, cost, latency,
//      finish/error and child (sub-agent) sessions per session;
//   6. runs the scenario assertion over the resulting workspace state.
//
// The executor, the fixture resolver and the database initializer are all
// injectable, so the whole runner dry-runs offline with a fake driver.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BudgetGuard } from '../budget';
import {
  RAG_EMBEDDING_PROVIDER,
  embeddingCredentialEnvVar,
  engineForCondition,
  type ConditionId,
  type EngineVersion,
} from '../config';
import { runCommand, type CommandRunner } from '../exec';
import {
  buildOpenCodeEnv,
  ensureIsolationDirs,
  isolationDirs,
  type IsolationDirs,
} from '../isolation/opencode';
import { buildMindEnv, type MindPaths } from '../mind/cli';

import type {
  BChildResult,
  BSessionOutcome,
  BSessionResult,
  BSessionStatus,
  Scenario,
  ScenarioAssertionResult,
} from './scenario';

/** Executed scenarios keep pass/fail; unsupported ones are explicitly not run. */
export type ScenarioRunStatus = 'passed' | 'failed' | 'not_run';

export interface BSessionLimits {
  readonly steps: number;
  readonly timeoutMs: number;
}

/** Everything the child worker needs to run ONE session. */
export interface BSessionJob {
  readonly runId: string;
  readonly scenarioId: string;
  readonly condition: ConditionId;
  readonly sessionIndex: number;
  readonly prompt: string;
  readonly workspaceDir: string;
  /** Unit directory (its `opencode/` sub-tree holds the isolated env). */
  readonly conditionDir: string;
  /** Directory for this session's job/result files. */
  readonly sessionDir: string;
  readonly evidenceDir: string;
  readonly limits: BSessionLimits;
  /** Full isolated environment for the child (never contains the raw key value). */
  readonly env: Record<string, string>;
  /** Absolute path to the unit's Mind database, or null for no-memory. */
  readonly mindDbPath: string | null;
  /** Engine binary the unit runs, or null for no-memory. */
  readonly mindBin: string | null;
  /** Extra skills the scenario installs and the isolation gate must allow. */
  readonly allowedSkills?: readonly string[];
}

export type BSessionExecutor = (job: BSessionJob) => Promise<BSessionOutcome>;

export function emptyBSessionOutcome(
  status: BSessionStatus,
  error: string | null,
  isolationOk = true
): BSessionOutcome {
  return {
    status,
    sessionId: '',
    finalText: '',
    toolCalls: [],
    memoryCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: null,
    error,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    children: [],
    rawMessages: { data: [] },
  };
}

// ── Result shapes ────────────────────────────────────────────────────────────

export interface ScenarioConditionResult {
  readonly scenarioId: string;
  readonly title: string;
  readonly condition: ConditionId;
  readonly prompts: readonly string[];
  readonly sessions: readonly BSessionResult[];
  readonly childResults: readonly BChildResult[];
  readonly childCount: number;
  readonly memoryCalls: number;
  readonly costUsd: number;
  readonly assertion: ScenarioAssertionResult;
  readonly mindDb: string | null;
  readonly error: string | null;
  /** `not_run` scenarios carry a reason and are excluded from failed counts. */
  readonly status: ScenarioRunStatus;
  readonly notRunReason: string | null;
}

export interface ScenarioAggregate {
  readonly condition: ConditionId;
  readonly scenarios: number;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  readonly childSessions: number;
  readonly memoryCalls: number;
  readonly costUsd: number;
}

// ── Runner options / deps ────────────────────────────────────────────────────

export interface RunScenariosOptions {
  readonly runId: string;
  readonly runDir: string;
  readonly conditions: readonly ConditionId[];
  readonly scenarios: readonly Scenario[];
  readonly limits: BSessionLimits;
  readonly budget: BudgetGuard;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /**
   * Provider credential env merged into each unit's child environment only.
   * Empty for offline/dry runs; never written to result artifacts.
   */
  readonly credentialEnv?: Record<string, string>;
}

export interface InitMindDbInput {
  readonly bin: string;
  readonly dirs: IsolationDirs;
  readonly runner: CommandRunner;
}

export interface RunScenariosDeps {
  /** Resolves a scenario's fixture directory to an absolute path. */
  readonly fixtureDirFor: (scenario: Scenario) => string;
  /** Absolute worktree paths per engine version (Mind conditions). */
  readonly worktrees: Partial<Record<EngineVersion, string>>;
  readonly executor: BSessionExecutor;
  /** Initializes a fresh empty Mind database; defaults to `mind status`. */
  readonly initMindDb?: (input: InitMindDbInput) => Promise<void>;
  /** Command port for database init + assertions; defaults to `runCommand`. */
  readonly runner?: CommandRunner;
  /** Recursively copies a fixture into the workspace; injectable for tests. */
  readonly copyDir?: (source: string, target: string) => void;
}

export interface ScenariosRunResult {
  readonly results: readonly ScenarioConditionResult[];
  readonly aggregates: readonly ScenarioAggregate[];
  readonly perConditionFiles: Record<string, string>;
  readonly spentUsd: number;
}

const RESULTS_DIR = 'results';

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** Run the pinned `mind` CLI once so its own engine creates the empty schema. */
async function defaultInitMindDb(input: InitMindDbInput): Promise<void> {
  mkdirSync(input.dirs.mindDataDir, { recursive: true });
  const paths: MindPaths = {
    dataDir: input.dirs.mindDataDir,
    dbPath: input.dirs.mindDb,
    syncRoot: input.dirs.syncRoot,
  };
  const env = buildMindEnv(paths, process.env, false) as Record<string, string | undefined>;
  const result = await input.runner({
    command: input.bin,
    args: ['status'],
    cwd: input.dirs.mindDataDir,
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`mind status failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function ensureDirs(dirs: IsolationDirs): void {
  ensureIsolationDirs(dirs);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function scenarioRunStatus(
  result: Pick<ScenarioConditionResult, 'assertion' | 'status'>
): ScenarioRunStatus {
  if (result.status === 'not_run') return 'not_run';
  return result.assertion.pass ? 'passed' : 'failed';
}

/**
 * Why a scenario cannot run in this condition, or `null` when it can. Gates are
 * deterministic and credential-only: they never call a provider.
 */
export function scenarioGateReason(
  scenario: Pick<Scenario, 'rag' | 'requires'>,
  condition: ConditionId,
  credentialEnv: Record<string, string>
): string | null {
  const isMind = engineForCondition(condition) !== null;
  const rag = scenario.rag === true;
  if (rag && !isMind) {
    return 'RAG requires a Mind condition';
  }
  if (rag) {
    const envVar = embeddingCredentialEnvVar(RAG_EMBEDDING_PROVIDER);
    if (!credentialEnv[envVar]) {
      return `scenario requests RAG but ${envVar} is not available`;
    }
  }
  for (const requirement of scenario.requires ?? []) {
    if (requirement === 'semantic-recall' && !rag) {
      return 'scenario requires semantic recall but does not enable RAG';
    }
    if (requirement === 'tier-maintenance' && engineForCondition(condition) !== 'current') {
      return `scenario requires tier maintenance, which needs the 'mind-current' condition`;
    }
    if (requirement === 'mind-memory' && !isMind) {
      return `scenario requires a Mind memory condition, but '${condition}' has no Mind database`;
    }
  }
  return null;
}

export function notRunScenarioResult(
  scenario: Scenario,
  condition: ConditionId,
  reason: string
): ScenarioConditionResult {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    condition,
    prompts: scenario.sessions.map(session => session.prompt),
    sessions: [],
    childResults: [],
    childCount: 0,
    memoryCalls: 0,
    costUsd: 0,
    assertion: { pass: false, details: [`not_run: ${reason}`] },
    mindDb: null,
    error: null,
    status: 'not_run',
    notRunReason: reason,
  };
}

function aggregateCondition(
  condition: ConditionId,
  results: readonly ScenarioConditionResult[]
): ScenarioAggregate {
  const statuses = results.map(result => scenarioRunStatus(result));
  return {
    condition,
    scenarios: results.length,
    passed: statuses.filter(status => status === 'passed').length,
    failed: statuses.filter(status => status === 'failed').length,
    notRun: statuses.filter(status => status === 'not_run').length,
    childSessions: results.reduce((sum, result) => sum + result.childCount, 0),
    memoryCalls: results.reduce(
      (sum, result) =>
        sum +
        result.memoryCalls +
        result.childResults.reduce((c, child) => c + child.memoryCalls, 0),
      0
    ),
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
  };
}

async function runUnit(
  options: RunScenariosOptions,
  deps: RunScenariosDeps,
  scenario: Scenario,
  condition: ConditionId,
  runner: CommandRunner
): Promise<ScenarioConditionResult> {
  const unitDir = join(options.runDir, 'scenarios', safeId(scenario.id), condition);
  const dirs = isolationDirs(unitDir);
  ensureDirs(dirs);

  const engine = engineForCondition(condition);
  let mindDb: string | null = null;
  if (engine !== null) {
    const worktree = deps.worktrees[engine];
    if (!worktree) {
      throw new Error(`no worktree configured for condition '${condition}' (${engine})`);
    }
    const init = deps.initMindDb ?? defaultInitMindDb;
    await init({ bin: join(worktree, 'mind'), dirs, runner });
    mindDb = dirs.mindDb;
  }

  const copyDir = deps.copyDir ?? ((source, target) => cpSync(source, target, { recursive: true }));
  copyDir(deps.fixtureDirFor(scenario), dirs.workspace);
  // Optional post-copy preparation (e.g. rename a fixture file into its final name).
  scenario.prepare?.({ workspaceDir: dirs.workspace });

  const mindBin = engine === null ? null : join(deps.worktrees[engine]!, 'mind');
  const env: Record<string, string> = {
    ...buildOpenCodeEnv({
      condition,
      dir: dirs,
      mindBin,
      rag: scenario.rag === true,
      embeddingProvider: scenario.rag === true ? RAG_EMBEDDING_PROVIDER : undefined,
    }),
    ...(options.credentialEnv ?? {}),
  };

  await scenario.seed?.({
    workspaceDir: dirs.workspace,
    mindDb,
    mindBin,
    env,
    run: invocation => runner({ ...invocation, cwd: invocation.cwd ?? dirs.workspace }),
  });

  const sessions: BSessionResult[] = [];
  for (let index = 0; index < scenario.sessions.length; index++) {
    const session = scenario.sessions[index]!;
    const sessionDir = join(unitDir, 'sessions', String(index));
    mkdirSync(sessionDir, { recursive: true });

    const job: BSessionJob = {
      runId: options.runId,
      scenarioId: scenario.id,
      condition,
      sessionIndex: index,
      prompt: session.prompt,
      workspaceDir: dirs.workspace,
      conditionDir: unitDir,
      sessionDir,
      evidenceDir: join(unitDir, 'isolation-evidence', String(index)),
      limits: options.limits,
      env,
      mindDbPath: mindDb,
      mindBin,
      ...(scenario.allowedSkills ? { allowedSkills: scenario.allowedSkills } : {}),
    };

    options.budget.assertCanSpend(0);
    const outcome = await deps
      .executor(job)
      .catch((error: unknown) => emptyBSessionOutcome('error', String(error)));
    options.budget.addCost(outcome.costUsd, `scenarios:${scenario.id}:${condition}:${index}`);

    const result: BSessionResult = { ...outcome, sessionIndex: index, prompt: session.prompt };
    sessions.push(result);
    writeJson(join(sessionDir, 'session.json'), result);
  }

  const childResults = sessions.flatMap(session => session.children);
  const assertion = await scenario.makeAssertion({
    workspaceDir: dirs.workspace,
    sessionResults: sessions,
    childResults,
    mindDb,
    run: invocation => runner({ ...invocation, cwd: invocation.cwd ?? dirs.workspace }),
  });

  const failedSession = sessions.find(session => session.status !== 'ok');
  const result: ScenarioConditionResult = {
    scenarioId: scenario.id,
    title: scenario.title,
    condition,
    prompts: scenario.sessions.map(session => session.prompt),
    sessions,
    childResults,
    childCount: childResults.length,
    memoryCalls: sessions.reduce((sum, session) => sum + session.memoryCalls, 0),
    costUsd: sessions.reduce((sum, session) => sum + session.costUsd, 0),
    assertion,
    mindDb,
    error: failedSession?.error ?? null,
    status: assertion.pass ? 'passed' : 'failed',
    notRunReason: null,
  };
  writeJson(join(unitDir, 'assertion.json'), assertion);
  return result;
}

export async function runScenarioRun(
  options: RunScenariosOptions,
  deps: RunScenariosDeps
): Promise<ScenariosRunResult> {
  const resultsDir = join(options.runDir, RESULTS_DIR);
  mkdirSync(resultsDir, { recursive: true });

  const runner = deps.runner ?? runCommand;
  const allResults: ScenarioConditionResult[] = [];
  const aggregates: ScenarioAggregate[] = [];
  const perConditionFiles: Record<string, string> = {};

  for (const condition of options.conditions) {
    const conditionResults: ScenarioConditionResult[] = [];
    for (const scenario of options.scenarios) {
      if (!existsSync(deps.fixtureDirFor(scenario))) {
        options.stderr(`scenarios: fixture missing for '${scenario.id}'; skipping`);
        continue;
      }
      const gateReason = scenarioGateReason(scenario, condition, options.credentialEnv ?? {});
      const result =
        gateReason === null
          ? await runUnit(options, deps, scenario, condition, runner)
          : notRunScenarioResult(scenario, condition, gateReason);
      conditionResults.push(result);
      allResults.push(result);
      const outcome =
        result.status === 'not_run'
          ? `not_run=${result.notRunReason}`
          : `assertion=${result.assertion.pass ? 'PASS' : 'FAIL'}`;
      options.stdout(
        `scenarios ${scenario.id}/${condition}: ${outcome} ` +
          `sessions=${result.sessions.length} children=${result.childCount} ` +
          `memoryCalls=${result.memoryCalls} cost=$${result.costUsd.toFixed(4)}`
      );
    }

    const file = join(resultsDir, `scenarios-${condition}.json`);
    writeJson(file, conditionResults);
    perConditionFiles[condition] = file;
    aggregates.push(aggregateCondition(condition, conditionResults));
  }

  writeJson(join(resultsDir, 'scenarios-aggregates.json'), { aggregates });

  return { results: allResults, aggregates, perConditionFiles, spentUsd: options.budget.spentUsd };
}

/** Read a stored `scenarios-<condition>.json` result file (used by T6). */
export function readScenarioResults(
  runDir: string,
  condition: ConditionId
): ScenarioConditionResult[] {
  const path = join(runDir, RESULTS_DIR, `scenarios-${condition}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as ScenarioConditionResult[];
}
