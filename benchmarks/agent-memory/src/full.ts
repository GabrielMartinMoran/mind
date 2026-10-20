// `full` orchestration: the free LoCoMo A1 stage always runs; the paid A2 and
// scenario stages run ONLY when a budget is supplied (and confirmed); then the
// REPORT.md is generated from whatever landed. No paid prompt is ever sent
// without an explicit cap.
//
// Every sub-stage is the real command its own CLI subcommand uses, so the
// orchestration adds no new behavior — it only sequences them on one run id.

import { runA2Command } from './benchmarkA/command';
import { runScenariosCommand } from './benchmarkB/command';
import { engineForCondition, type ConditionId } from './config';
import type { CommandRunner } from './exec';
import { runLocomoCommand } from './locomo/command';
import type { SubsetName } from './locomo/subset';
import { runReportCommand } from './report';
import { createRunId } from './run';

export interface FullCommandOptions {
  /** Explicit run id, or null to generate a fresh one shared by every stage. */
  readonly runId: string | null;
  readonly runsRoot: string;
  readonly workRoot: string;
  readonly conditions: readonly ConditionId[];
  readonly subset: SubsetName;
  /** Hard cost cap; null runs only the free A1 stage. */
  readonly budgetUsd: number | null;
  readonly confirm: boolean;
  /** Independent repetitions per (condition, question) for A2. Default 1. */
  readonly reps?: number;
  readonly scenarios: readonly string[];
  readonly outPath: string;
}

/** Nominal stages of a `full` run, in execution order. */
export type FullStageName = 'locomo' | 'a2' | 'scenarios' | 'report';

/** What a `full` invocation is allowed to do given its cost/confirm gate. */
export type FullMode = 'free-only' | 'refuse' | 'paid';

export interface FullStagePlan {
  readonly mode: FullMode;
  /** Stages that run, in order. `refuse` keeps only the free A1 stage. */
  readonly stages: readonly FullStageName[];
}

export interface FullPlanInput {
  readonly budgetUsd: number | null;
  readonly confirm: boolean;
}

/**
 * Pure gating predicate: the single place that decides whether a `full` run may
 * spend. A null budget means free-only; a budget without `--confirm` refuses
 * before any paid stage; a confirmed budget unlocks the paid A2 + scenarios
 * stages. The report always comes last (except on refusal, which stops early).
 */
export function planFullStages(input: FullPlanInput): FullStagePlan {
  if (input.budgetUsd === null) {
    return { mode: 'free-only', stages: ['locomo', 'report'] };
  }
  if (!input.confirm) {
    return { mode: 'refuse', stages: ['locomo'] };
  }
  return { mode: 'paid', stages: ['locomo', 'a2', 'scenarios', 'report'] };
}

/** The stage entry points a `full` run sequences. */
export interface FullStages {
  readonly locomo: typeof runLocomoCommand;
  readonly a2: typeof runA2Command;
  readonly scenarios: typeof runScenariosCommand;
  readonly report: typeof runReportCommand;
}

export interface FullCommandDeps {
  readonly repoRoot: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Overrides the real stage entry points (tests). */
  readonly stages?: Partial<FullStages>;
}

const DEFAULT_STAGES: FullStages = {
  locomo: runLocomoCommand,
  a2: runA2Command,
  scenarios: runScenariosCommand,
  report: runReportCommand,
};

export async function runFullCommand(
  options: FullCommandOptions,
  deps: FullCommandDeps
): Promise<number> {
  const mindConditions = options.conditions.filter(
    condition => engineForCondition(condition) !== null
  );
  if (mindConditions.length === 0) {
    deps.stderr('full: A1 requires at least one Mind condition (mind-v9, mind-v10).');
    return 2;
  }

  const stages: FullStages = {
    locomo: deps.stages?.locomo ?? DEFAULT_STAGES.locomo,
    a2: deps.stages?.a2 ?? DEFAULT_STAGES.a2,
    scenarios: deps.stages?.scenarios ?? DEFAULT_STAGES.scenarios,
    report: deps.stages?.report ?? DEFAULT_STAGES.report,
  };
  const plan = planFullStages({ budgetUsd: options.budgetUsd, confirm: options.confirm });

  const runId = options.runId ?? createRunId();
  deps.stdout(`full run ${runId}: subset=${options.subset}`);

  // Free A1 stage — always.
  const locomoCode = await stages.locomo(
    {
      subset: options.subset,
      conditions: mindConditions,
      runId,
      runsRoot: options.runsRoot,
      workRoot: options.workRoot,
    },
    { repoRoot: deps.repoRoot, runner: deps.runner, stdout: deps.stdout, stderr: deps.stderr }
  );
  if (locomoCode !== 0) {
    deps.stderr(`full: A1 stage failed (exit ${locomoCode}); stopping.`);
    return locomoCode;
  }

  // Paid stages — only with an explicit, confirmed budget.
  if (plan.mode === 'refuse') {
    deps.stderr('full: refusing paid A2/scenarios without --confirm (kept the free A1 results).');
    return 2;
  }

  if (plan.mode === 'free-only') {
    deps.stdout('full: no --budget; paid A2/scenarios skipped (free A1 only).');
  } else {
    const a2Code = await stages.a2(
      {
        runId,
        runsRoot: options.runsRoot,
        workRoot: options.workRoot,
        conditions: options.conditions,
        budgetUsd: options.budgetUsd,
        reps: options.reps ?? 1,
        judgeOnly: false,
      },
      { repoRoot: deps.repoRoot, runner: deps.runner, stdout: deps.stdout, stderr: deps.stderr }
    );
    if (a2Code !== 0) {
      deps.stderr(
        `full: A2 stage failed (exit ${a2Code}); generating report from partial results.`
      );
    } else {
      const scenariosCode = await stages.scenarios(
        {
          runId,
          runsRoot: options.runsRoot,
          workRoot: options.workRoot,
          conditions: options.conditions,
          scenarios: options.scenarios,
          budgetUsd: options.budgetUsd,
        },
        { repoRoot: deps.repoRoot, runner: deps.runner, stdout: deps.stdout, stderr: deps.stderr }
      );
      if (scenariosCode !== 0) {
        deps.stderr(
          `full: scenarios stage failed (exit ${scenariosCode}); generating report anyway.`
        );
      }
    }
  }

  return stages.report(
    { runId, runsRoot: options.runsRoot, outPath: options.outPath },
    { repoRoot: deps.repoRoot, stdout: deps.stdout, stderr: deps.stderr }
  );
}
