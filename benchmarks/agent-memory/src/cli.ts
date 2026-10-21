// Harness CLI dispatcher.
//
// Only the stages T2 can actually perform are wired here: `probe` (shells to
// the T1 probe script) and `clean` (removes run directories). The paid stages
// (smoke/locomo/scenarios/full) require an explicit `--budget` and are stubbed
// until their tasks land; they always refuse to spend without a cap.

import { readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { runA2Command } from './benchmarkA/command';
import { runScenariosCommand } from './benchmarkB/command';
import {
  DEFAULT_CONDITIONS,
  PILOT_BUDGET_USD,
  SMOKE_BUDGET_USD,
  isCondition,
  type ConditionId,
} from './config';
import { runCommand, type CommandRunner } from './exec';
import { runFullCommand } from './full';
import { runLocomoCommand } from './locomo/command';
import { SUBSET_SIZES, type SubsetName } from './locomo/subset';
import { runReportCommand } from './report';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export const COMMANDS = [
  'probe',
  'smoke',
  'locomo',
  'scenarios',
  'full',
  'report',
  'clean',
] as const;

export type CommandName = (typeof COMMANDS)[number];

/**
 * Commands that always send paid prompts and therefore require `--budget` on
 * their own. `full` is handled separately: it runs the free A1 stage first and
 * only runs its paid sub-stages when a budget is supplied.
 */
export const PAID_COMMANDS: readonly CommandName[] = ['smoke', 'scenarios'];

export interface CliOptions {
  readonly command: CommandName | 'help';
  readonly runsRoot: string;
  readonly workRoot: string;
  readonly budgetUsd: number | null;
  readonly conditions: readonly ConditionId[];
  readonly confirm: boolean;
  readonly all: boolean;
  /** LoCoMo subset size for the `locomo` command. */
  readonly subset: SubsetName;
  /** Explicit run id for the `locomo` command (`null` = generate one). */
  readonly runId: string | null;
  /** `locomo --answers`: run the paid A2 answering stage. */
  readonly answers: boolean;
  /** `locomo --judge-only --run-id <id>`: re-judge stored answers (paid). */
  readonly judgeOnly: boolean;
  /** Independent repetitions per (condition, question) for A2. Default 1. */
  readonly reps: number;
  /** Explicit scenario ids for the `scenarios` command (empty = all). */
  readonly scenarios: readonly string[];
  /** `report`/`full` output path (relative to repo root); null = default. */
  readonly outPath: string | null;
}

function isSubsetName(value: string): value is SubsetName {
  return Object.prototype.hasOwnProperty.call(SUBSET_SIZES, value);
}

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'help';
  let runsRoot = 'benchmarks/agent-memory/runs';
  let workRoot = 'benchmarks/agent-memory/.work';
  let budgetUsd: number | null = null;
  const conditions: ConditionId[] = [];
  let confirm = false;
  let all = false;
  let subset: SubsetName = 'pilot';
  let runId: string | null = null;
  let answers = false;
  let judgeOnly = false;
  let reps = 1;
  const scenarios: string[] = [];
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      command = 'help';
      continue;
    }
    if (arg === '--runs-root') {
      runsRoot = required(argv, ++i, '--runs-root');
      continue;
    }
    if (arg === '--work-root') {
      workRoot = required(argv, ++i, '--work-root');
      continue;
    }
    if (arg === '--budget') {
      const raw = required(argv, ++i, '--budget');
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new CliError(`invalid --budget value: ${raw}`);
      }
      budgetUsd = parsed;
      continue;
    }
    if (arg === '--out') {
      outPath = required(argv, ++i, '--out');
      continue;
    }
    if (arg === '--condition') {
      const value = required(argv, ++i, '--condition');
      if (!isCondition(value)) throw new CliError(`unknown condition: ${value}`);
      conditions.push(value);
      continue;
    }
    if (arg === '--conditions') {
      const value = required(argv, ++i, '--conditions');
      for (const part of value.split(',')) {
        const name = part.trim();
        if (name.length === 0) continue;
        if (!isCondition(name)) throw new CliError(`unknown condition: ${name}`);
        conditions.push(name);
      }
      continue;
    }
    if (arg === '--subset') {
      const value = required(argv, ++i, '--subset');
      if (!isSubsetName(value)) throw new CliError(`unknown subset: ${value}`);
      subset = value;
      continue;
    }
    if (arg === '--run-id') {
      runId = required(argv, ++i, '--run-id');
      continue;
    }
    if (arg === '--answers') {
      answers = true;
      continue;
    }
    if (arg === '--judge-only') {
      judgeOnly = true;
      continue;
    }
    if (arg === '--reps') {
      const raw = required(argv, ++i, '--reps');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliError(`invalid --reps value (expected a positive integer): ${raw}`);
      }
      reps = parsed;
      continue;
    }
    if (arg === '--scenarios') {
      const value = required(argv, ++i, '--scenarios');
      for (const part of value.split(',')) {
        const name = part.trim();
        if (name.length > 0) scenarios.push(name);
      }
      continue;
    }
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg.startsWith('--')) throw new CliError(`unknown flag: ${arg}`);
    if (command !== 'help') throw new CliError(`unexpected argument: ${arg}`);
    if (!isCommandName(arg)) throw new CliError(`unknown command: ${arg}`);
    command = arg;
  }

  if (judgeOnly && runId === null) {
    throw new CliError('--judge-only requires --run-id <id>');
  }

  return {
    command,
    runsRoot,
    workRoot,
    budgetUsd,
    conditions: conditions.length > 0 ? conditions : [...DEFAULT_CONDITIONS],
    confirm,
    all,
    subset,
    runId,
    answers,
    judgeOnly,
    reps,
    scenarios,
    outPath,
  };
}

function required(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} requires a value`);
  return value;
}

export function usage(): string {
  return [
    'Usage: bun run benchmarks/agent-memory/src/cli.ts <command> [options]',
    '',
    'Commands:',
    '  probe      Run the free T1 platform/isolation probes',
    '  smoke      Paid smoke test (requires --budget, <= $0.05)      [not implemented: T7]',
    '  locomo     LoCoMo A1 retrieval (free); --answers adds paid A2; --judge-only re-judges',
    '  scenarios  Paid scenario run (requires --budget); --scenarios b1,b4 selects',
    '  full       Free A1 always; paid A2 + scenarios with --budget; then report',
    '  report     Generate REPORT.md from stored results (free; requires --run-id)',
    '  clean      Remove run directories (never touches worktrees unless --all)',
    '',
    'Options:',
    '  --runs-root <path>   Run output root (default: benchmarks/agent-memory/runs)',
    '  --work-root <path>   Worktree/scratch root (default: benchmarks/agent-memory/.work)',
    `  --budget <usd>       Hard cost cap; required for paid commands (smoke cap $${SMOKE_BUDGET_USD}, pilot cap $${PILOT_BUDGET_USD})`,
    '  --condition <id>     Limit to a condition (repeatable)',
    '  --conditions <a,b>   Comma-separated conditions (default: mind-current;',
    '                       historical: mind-v9,mind-v10; baseline: no-memory)',
    '  --subset <name>      LoCoMo subset: pilot (5) | full (30) (default: pilot)',
    '  --run-id <id>        Explicit run id (locomo; scenarios)',
    '  --answers            With locomo: run the paid A2 answering + judge stages',
    '                       (needs --budget --confirm --run-id of a prepared run)',
    '  --judge-only         With locomo: re-judge stored answers (needs --budget --run-id)',
    '  --reps <n>           With locomo --answers / full: repetitions per (condition, question) (default 1)',
    '  --scenarios <a,b>    With scenarios: scenario ids to run (default: all)',
    '  --out <path>         With report/full: output path (default benchmarks/agent-memory/REPORT.md)',
    '  --confirm            Explicitly acknowledge a paid run',
    '  --all                With clean: also remove prepared worktrees',
  ].join('\n');
}

export interface CleanFs {
  listDir(path: string): string[];
  removeDir(path: string): void;
}

export const realCleanFs: CleanFs = {
  listDir: path => readdirSync(path, { withFileTypes: true }).map(e => e.name),
  removeDir: path => rmSync(path, { recursive: true, force: true }),
};

// Refuse to delete anything unless the target really looks like a runs root,
// so a bad `--runs-root` can never wipe an arbitrary directory.
export function assertSafeRunRoot(runsRoot: string): void {
  if (basename(resolve(runsRoot)) !== 'runs') {
    throw new CliError(`refusing to clean '${runsRoot}': runs root basename must be 'runs'`);
  }
}

// The work root is only ever removed with `--all`; require it to be named
// `.work` (the harness's own scratch root) so a bad path can never wipe an
// unrelated directory.
export function assertSafeWorkRoot(workRoot: string): void {
  if (basename(resolve(workRoot)) !== '.work') {
    throw new CliError(`refusing to clean '${workRoot}': work root basename must be '.work'`);
  }
}

export interface CleanResult {
  readonly removedRuns: string[];
  readonly removedWorktrees: string[];
  readonly removedWork: string[];
}

export function cleanRuns(
  options: Pick<CliOptions, 'runsRoot' | 'workRoot' | 'all'>,
  fs: CleanFs = realCleanFs
): CleanResult {
  assertSafeRunRoot(options.runsRoot);

  const removedRuns: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.listDir(options.runsRoot);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const path = join(options.runsRoot, name);
    fs.removeDir(path);
    removedRuns.push(path);
  }

  const removedWorktrees: string[] = [];
  const removedWork: string[] = [];
  if (options.all) {
    assertSafeWorkRoot(options.workRoot);
    const worktrees = join(options.workRoot, 'worktrees');
    let names: string[] = [];
    try {
      names = fs.listDir(worktrees);
    } catch {
      names = [];
    }
    for (const name of names) {
      const path = join(worktrees, name);
      fs.removeDir(path);
      removedWorktrees.push(path);
    }

    // Everything else under `.work/` is scratch too (dataset cache, caches).
    let workEntries: string[] = [];
    try {
      workEntries = fs.listDir(options.workRoot);
    } catch {
      workEntries = [];
    }
    for (const name of workEntries) {
      if (name === 'worktrees') continue;
      const path = join(options.workRoot, name);
      fs.removeDir(path);
      removedWork.push(path);
    }
  }

  return { removedRuns, removedWorktrees, removedWork };
}

export interface DispatchDeps {
  readonly runner: CommandRunner;
  readonly repoRoot: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Injected by the entry point (and tests); runs the free `locomo` command. */
  readonly locomoRunner?: LocomoRunner;
  /** Injected by the entry point; runs the paid A2 stage (`locomo --answers`). */
  readonly a2Runner?: A2CliRunner;
  /** Injected by the entry point; runs the paid `scenarios` stage. */
  readonly scenariosRunner?: ScenariosCliRunner;
  /** Injected by the entry point; generates REPORT.md (free). */
  readonly reportRunner?: ReportCliRunner;
  /** Injected by the entry point; runs the `full` orchestration. */
  readonly fullRunner?: FullCliRunner;
  /** Injectable filesystem for `clean` (tests); defaults to the real one. */
  readonly cleanFs?: CleanFs;
}

export type LocomoRunner = (options: CliOptions, deps: DispatchDeps) => Promise<number>;
export type A2CliRunner = (options: CliOptions, deps: DispatchDeps) => Promise<number>;
export type ScenariosCliRunner = (options: CliOptions, deps: DispatchDeps) => Promise<number>;
export type ReportCliRunner = (options: CliOptions, deps: DispatchDeps) => Promise<number>;
export type FullCliRunner = (options: CliOptions, deps: DispatchDeps) => Promise<number>;

export async function dispatch(options: CliOptions, deps: DispatchDeps): Promise<number> {
  if (options.command === 'help') {
    deps.stdout(usage());
    return 0;
  }

  if (options.command === 'probe') {
    const script = join(deps.repoRoot, 'benchmarks/agent-memory/probes/run-t1-probes.sh');
    const result = await deps.runner({
      command: 'bash',
      args: [script],
      cwd: deps.repoRoot,
      env: process.env,
    });
    return result.exitCode;
  }

  // LoCoMo: the free A1 stage, or the paid A2 answering/judge stages.
  if (options.command === 'locomo') {
    const paid = options.answers || options.judgeOnly;
    if (paid) {
      if (options.budgetUsd === null) {
        deps.stderr(
          `refusing to run paid 'locomo ${options.judgeOnly ? '--judge-only' : '--answers'}' ` +
            `without --budget. Pass --budget <usd> and --confirm.`
        );
        return 2;
      }
      if (!options.confirm) {
        deps.stderr(`refusing to run paid 'locomo --answers/--judge-only' without --confirm.`);
        return 2;
      }
      if (!deps.a2Runner) {
        deps.stderr('a2 runner is not wired in this entry point.');
        return 3;
      }
      return deps.a2Runner(options, deps);
    }
    if (!deps.locomoRunner) {
      deps.stderr('locomo runner is not wired in this entry point.');
      return 3;
    }
    return deps.locomoRunner(options, deps);
  }

  if (options.command === 'scenarios') {
    if (options.budgetUsd === null) {
      deps.stderr(
        `refusing to run paid 'scenarios' without --budget. ` +
          `Pass --budget <usd> (smoke cap $${SMOKE_BUDGET_USD}, pilot cap $${PILOT_BUDGET_USD}) and --confirm.`
      );
      return 2;
    }
    if (!options.confirm) {
      deps.stderr(`refusing to run paid 'scenarios' without --confirm.`);
      return 2;
    }
    if (!deps.scenariosRunner) {
      deps.stderr('scenarios runner is not wired in this entry point.');
      return 3;
    }
    return deps.scenariosRunner(options, deps);
  }

  if (options.command === 'clean') {
    // Relative runs/work roots are project-relative, not cwd-relative: the CLI
    // must behave the same from the repo root, the subproject, or anywhere else.
    const cleaned = cleanRuns(
      {
        runsRoot: resolve(deps.repoRoot, options.runsRoot),
        workRoot: resolve(deps.repoRoot, options.workRoot),
        all: options.all,
      },
      deps.cleanFs ?? realCleanFs
    );
    deps.stdout(
      `removed ${cleaned.removedRuns.length} run dir(s)` +
        (options.all
          ? ` and ${cleaned.removedWorktrees.length} worktree(s) and ${cleaned.removedWork.length} scratch entr(ies)`
          : '')
    );
    return 0;
  }

  if (options.command === 'report') {
    if (options.runId === null) {
      deps.stderr('report requires --run-id <id> of an existing run.');
      return 2;
    }
    if (!deps.reportRunner) {
      deps.stderr('report runner is not wired in this entry point.');
      return 3;
    }
    return deps.reportRunner(options, deps);
  }

  if (options.command === 'full') {
    if (!deps.fullRunner) {
      deps.stderr('full runner is not wired in this entry point.');
      return 3;
    }
    return deps.fullRunner(options, deps);
  }

  // Paid stages.
  if (options.budgetUsd === null) {
    deps.stderr(
      `refusing to run paid command '${options.command}' without --budget. ` +
        `Pass --budget <usd> (smoke cap $${SMOKE_BUDGET_USD}, pilot cap $${PILOT_BUDGET_USD}) and --confirm.`
    );
    return 2;
  }
  if (!options.confirm) {
    deps.stderr(`refusing to run paid command '${options.command}' without --confirm.`);
    return 2;
  }
  deps.stderr(
    `'${options.command}' is not implemented yet (T3/T4/T5/T7). ` +
      `Budget accepted: $${options.budgetUsd}.`
  );
  return 3;
}

// Entry point used by the `bench-agent-memory-*` make targets. Guarded by
// `import.meta.main` so importing this module from tests has no side effects.
if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../../..');
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const code = await dispatch(options, {
      runner: runCommand,
      repoRoot,
      stdout: line => console.log(line),
      stderr: line => console.error(line),
      locomoRunner: (opts, deps) =>
        runLocomoCommand(
          {
            subset: opts.subset,
            conditions: opts.conditions,
            runId: opts.runId,
            runsRoot: opts.runsRoot,
            workRoot: opts.workRoot,
          },
          {
            repoRoot: deps.repoRoot,
            runner: deps.runner,
            stdout: deps.stdout,
            stderr: deps.stderr,
          }
        ),
      a2Runner: (opts, deps) => {
        if (opts.runId === null) {
          deps.stderr(
            'locomo --answers/--judge-only requires --run-id <id> of a prepared run ' +
              '(run the free locomo stage first).'
          );
          return Promise.resolve(2);
        }
        return runA2Command(
          {
            runId: opts.runId,
            runsRoot: opts.runsRoot,
            workRoot: opts.workRoot,
            conditions: opts.conditions,
            budgetUsd: opts.budgetUsd,
            reps: opts.reps,
            judgeOnly: opts.judgeOnly,
          },
          {
            repoRoot: deps.repoRoot,
            runner: deps.runner,
            stdout: deps.stdout,
            stderr: deps.stderr,
          }
        );
      },
      scenariosRunner: (opts, deps) =>
        runScenariosCommand(
          {
            runId: opts.runId,
            runsRoot: opts.runsRoot,
            workRoot: opts.workRoot,
            conditions: opts.conditions,
            scenarios: opts.scenarios,
            budgetUsd: opts.budgetUsd,
          },
          {
            repoRoot: deps.repoRoot,
            runner: deps.runner,
            stdout: deps.stdout,
            stderr: deps.stderr,
          }
        ),
      reportRunner: (opts, deps) =>
        runReportCommand(
          {
            runId: opts.runId!,
            runsRoot: opts.runsRoot,
            outPath: opts.outPath ?? 'benchmarks/agent-memory/REPORT.md',
          },
          { repoRoot: deps.repoRoot, stdout: deps.stdout, stderr: deps.stderr }
        ),
      fullRunner: (opts, deps) =>
        runFullCommand(
          {
            runId: opts.runId,
            runsRoot: opts.runsRoot,
            workRoot: opts.workRoot,
            conditions: opts.conditions,
            subset: opts.subset,
            budgetUsd: opts.budgetUsd,
            confirm: opts.confirm,
            reps: opts.reps,
            scenarios: opts.scenarios,
            outPath: opts.outPath ?? 'benchmarks/agent-memory/REPORT.md',
          },
          {
            repoRoot: deps.repoRoot,
            runner: deps.runner,
            stdout: deps.stdout,
            stderr: deps.stderr,
          }
        ),
    });
    process.exit(code);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}
