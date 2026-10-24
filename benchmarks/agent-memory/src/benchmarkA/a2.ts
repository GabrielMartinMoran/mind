// Benchmark A2 — real OpenCode answering over a LoCoMo subset.
//
// For every (condition × question) the runner:
//   1. prepares a fresh unit directory and, for Mind conditions, a byte-identical
//      copy of the ingested condition database;
//   2. spawns ONE isolated child process (its own env + dirs) that verifies
//      isolation, opens ONE new session and runs the SAME prompt to completion;
//   3. captures the final answer, memory calls, tokens, cost, model and latency;
//   4. scores deterministically and aggregates per condition.
//
// The prompt template is a single condition-independent constant: it never
// mentions memory, Mind, or any engine name, and it instructs the canonical
// abstention sentence. The process executor is injectable so the whole runner
// can dry-run against a fake driver with no network.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BudgetGuard } from '../budget';
import type { ConditionId } from '../config';
import { TEMPERATURE_REQUESTED, applyMindDatabase } from '../isolation/opencode';
import type { SubsetItem } from '../locomo/subset';
import { copyMindDatabaseForQuestion, type ConditionProfile } from '../opencode/conditions';
import type {
  DriverEvidence,
  DriverIdleOutcome,
  DriverModelRef,
  DriverTokenUsage,
} from '../opencode/driver';
import { redactEnv } from '../redact';

import {
  ABSTENTION_CANONICAL,
  aggregateCondition,
  questionRepRows,
  scoreDeterministic,
  type A2Class,
  type A2Completion,
  type A2QuestionResult,
  type ConditionAggregate,
} from './judge';

// ── Prompt template ──────────────────────────────────────────────────────────

/**
 * The single A2 prompt template. Identical for every condition; contains no
 * memory/engine/condition reference. The question text is appended verbatim.
 */
export const A2_PROMPT_TEMPLATE = [
  'Answer the question below as concisely as possible, using only a single short sentence.',
  'Do not explain your reasoning.',
  `If the information needed to answer is not available, reply exactly: ${ABSTENTION_CANONICAL}`,
  '',
  'Question:',
].join('\n');

export function buildA2Prompt(question: string): string {
  return `${A2_PROMPT_TEMPLATE}\n${question}`;
}

// ── Limits ───────────────────────────────────────────────────────────────────

export interface A2Limits {
  readonly steps: number;
  readonly timeoutMs: number;
}

// ── Unit contract (parent ↔ child) ───────────────────────────────────────────

export type A2UnitStatus = 'ok' | 'auth' | 'timeout' | 'contaminated' | 'error';

export interface A2UnitJob {
  readonly runId: string;
  readonly condition: ConditionId;
  readonly questionId: string;
  /** Zero-based repetition index (absent on legacy fixtures). */
  readonly rep?: number;
  readonly adversarial: boolean;
  readonly prompt: string;
  readonly workspaceDir: string;
  readonly conditionDir: string;
  readonly unitDir: string;
  readonly evidenceDir: string;
  readonly limits: A2Limits;
  /** Full isolated environment for the child (never contains the raw key value). */
  readonly env: Record<string, string>;
  /** Absolute path to the per-question mind database copy, or null. */
  readonly mindDbPath: string | null;
  /** Engine binary the unit runs, or null for no-memory. */
  readonly mindBin: string | null;
}

export interface A2UnitOutcome {
  readonly status: A2UnitStatus;
  readonly answer: string;
  readonly memoryCalls: number;
  readonly toolCalls: number;
  readonly model: DriverModelRef | null;
  readonly tokens: DriverTokenUsage | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly steps: number;
  readonly finish: string | null;
  readonly children: readonly string[];
  readonly error: string | null;
  readonly errorType: string | null;
  readonly isolationOk: boolean;
  /**
   * Terminal session outcome. The real worker always records these fields;
   * legacy executors may omit them, in which case the status decides.
   */
  readonly idleOutcome?: DriverIdleOutcome | null;
  readonly completion?: A2Completion;
  /** Redacted execution evidence captured by the driver. */
  readonly evidence?: DriverEvidence;
}

export type A2UnitExecutor = (job: A2UnitJob) => Promise<A2UnitOutcome>;

/**
 * Resolve whether a unit completed. An explicit `completion` wins, then an
 * explicit idle outcome (from the outcome or its evidence), then the legacy
 * status. A non-successful idle outcome is never a completed answer.
 */
export function resolveA2Completion(
  outcome: Pick<A2UnitOutcome, 'status' | 'completion' | 'idleOutcome' | 'evidence'>
): A2Completion {
  if (outcome.completion) return outcome.completion;
  const idleOutcome =
    outcome.idleOutcome !== undefined ? outcome.idleOutcome : outcome.evidence?.idleOutcome;
  if (idleOutcome !== undefined) return idleOutcome === 'succeeded' ? 'complete' : 'incomplete';
  return outcome.status === 'ok' ? 'complete' : 'incomplete';
}

export function emptyA2Outcome(status: A2UnitStatus, error: string | null): A2UnitOutcome {
  return {
    status,
    answer: '',
    memoryCalls: 0,
    toolCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: null,
    children: [],
    error,
    errorType: status === 'ok' ? null : status,
    isolationOk: status !== 'contaminated',
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface RunA2Options {
  readonly runId: string;
  readonly runDir: string;
  readonly conditions: readonly ConditionId[];
  readonly subset: readonly SubsetItem[];
  readonly limits: A2Limits;
  /** Number of independent repetitions per (condition, question). Default 1. */
  readonly reps?: number;
  readonly budget: BudgetGuard;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface RunA2Deps {
  readonly profiles: Partial<Record<ConditionId, ConditionProfile>>;
  /** Source ingested database per Mind condition (for the per-question copy). */
  readonly sourceDb: Partial<Record<ConditionId, string>>;
  readonly executor: A2UnitExecutor;
  /** Copies a source DB to a per-question target; injectable for tests. */
  readonly copyDb?: (source: string, target: string) => { sha256: string };
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

const RESULTS_DIR = 'results';

export interface A2RunResult {
  readonly aggregates: ConditionAggregate[];
  readonly results: readonly A2QuestionResult[];
  readonly perConditionFiles: Record<string, string>;
  readonly perConditionMeansFiles: Record<string, string>;
  readonly spentUsd: number;
}

export async function runA2(options: RunA2Options, deps: RunA2Deps): Promise<A2RunResult> {
  const resultsDir = join(options.runDir, RESULTS_DIR);
  mkdirSync(resultsDir, { recursive: true });
  const reps = options.reps ?? 1;
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error(`reps must be a positive integer, got ${reps}`);
  }

  const allResults: A2QuestionResult[] = [];
  const perConditionFiles: Record<string, string> = {};
  const perConditionMeansFiles: Record<string, string> = {};
  const aggregates: ConditionAggregate[] = [];

  for (const condition of options.conditions) {
    const profile = deps.profiles[condition];
    if (!profile) {
      options.stderr(`a2: no prepared profile for condition '${condition}'; skipping`);
      continue;
    }
    const conditionResults: A2QuestionResult[] = [];
    const rawDir = join(resultsDir, `a2-${condition}`);
    mkdirSync(rawDir, { recursive: true });

    for (let rep = 0; rep < reps; rep++) {
      for (const item of options.subset) {
        const unitDir = join(options.runDir, 'a2', condition, safeId(item.id), `rep-${rep}`);
        const unitWorkspace = join(unitDir, 'workspace');
        mkdirSync(unitWorkspace, { recursive: true });

        // One byte-identical copy of the ingested condition database per
        // (condition, question, rep); the child env and the `mind` MCP server
        // config are rewired to read THAT copy, never the condition-level DB.
        let mindDbPath: string | null = null;
        let env = profile.env;
        const source = deps.sourceDb[condition] ?? null;
        if (profile.engine !== null && source) {
          const target = join(unitDir, 'mind.db');
          const copy = deps.copyDb ?? defaultCopyDb;
          copy(source, target);
          mindDbPath = target;
          env = applyMindDatabase(profile.env, {
            dbPath: target,
            dataDir: unitDir,
            syncRoot: join(unitDir, 'syncroot'),
          });
        }

        const job: A2UnitJob = {
          runId: options.runId,
          condition,
          questionId: item.id,
          rep,
          adversarial: item.adversarial,
          prompt: buildA2Prompt(item.question),
          workspaceDir: unitWorkspace,
          conditionDir: profile.dirs.conditionDir,
          unitDir,
          evidenceDir: join(unitDir, 'isolation-evidence'),
          limits: options.limits,
          env,
          mindDbPath,
          mindBin: profile.mindBin,
        };

        options.budget.assertCanSpend(0);
        const outcome = await deps.executor(job).catch(error => {
          options.stderr(`a2: unit ${condition}/${item.id}#${rep} failed: ${String(error)}`);
          return emptyA2Outcome('error', String(error));
        });
        options.budget.addCost(outcome.costUsd, `a2:${condition}:${item.id}:rep${rep}`);

        const completion = resolveA2Completion(outcome);
        const deterministic = scoreDeterministic({
          answer: outcome.answer,
          reference: item.answer,
          adversarial: item.adversarial,
          error: outcome.status !== 'ok',
          completion,
        });

        const result: A2QuestionResult = {
          id: item.id,
          rep,
          category: item.category,
          categoryName: item.categoryName,
          adversarial: item.adversarial,
          condition,
          answer: outcome.answer,
          reference: item.answer,
          deterministic,
          completion,
          judge: null,
          memoryCalls: outcome.memoryCalls,
          tokens: outcome.tokens,
          costUsd: outcome.costUsd,
          latencyMs: outcome.latencyMs,
          error: outcome.error,
        };
        conditionResults.push(result);
        allResults.push(result);

        writeFileSync(
          join(rawDir, `${safeId(item.id)}-rep${rep}.raw.json`),
          `${JSON.stringify({ job: { ...job, env: redactEnv(job.env) }, outcome }, null, 2)}\n`,
          'utf8'
        );
      }
    }

    const file = join(resultsDir, `a2-${condition}.json`);
    writeFileSync(file, `${JSON.stringify(conditionResults, null, 2)}\n`, 'utf8');
    perConditionFiles[condition] = file;

    const meansFile = join(resultsDir, `a2-${condition}-means.json`);
    writeFileSync(
      meansFile,
      `${JSON.stringify(questionRepRows(conditionResults), null, 2)}\n`,
      'utf8'
    );
    perConditionMeansFiles[condition] = meansFile;

    const aggregate = aggregateCondition(condition, conditionResults);
    aggregates.push(aggregate);
    options.stdout(
      `a2 ${condition}: ${conditionResults.length} measurements (${options.subset.length}Q × ${reps}rep), ` +
        `correct=${aggregate.classes.correct} partial=${aggregate.classes.partial} ` +
        `incorrect=${aggregate.classes.incorrect} ` +
        `abstention=${aggregate.classes.abstention} ` +
        `abstention_adversarial=${aggregate.classes.correct_abstention} ` +
        `empty=${aggregate.classes.empty_answer} incomplete=${aggregate.classes.incomplete} ` +
        `hallucination=${aggregate.classes.hallucination} error=${aggregate.classes.error} ` +
        `memoryCalls=${aggregate.memoryCalls}`
    );
  }

  writeFileSync(
    join(resultsDir, 'a2-aggregates.json'),
    `${JSON.stringify(
      { temperatureRequested: TEMPERATURE_REQUESTED, reps, aggregates },
      null,
      2
    )}\n`,
    'utf8'
  );

  return {
    aggregates,
    results: allResults,
    perConditionFiles,
    perConditionMeansFiles,
    spentUsd: options.budget.spentUsd,
  };
}

function defaultCopyDb(source: string, target: string): { sha256: string } {
  return copyMindDatabaseForQuestion(source, target);
}

// Re-exported so callers can build a busy class count without importing judge.
export type { A2Class, A2Completion, ConditionAggregate, A2QuestionResult };

// Kept exported here for callers that already import it from this module.
export { redactEnv };
