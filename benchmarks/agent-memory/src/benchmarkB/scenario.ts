// Benchmark B: scenario model shared by the runner, the worker and the fixtures.
//
// A scenario is a tiny, deterministic agent task with a production phase
// (session 1 produces information/decisions) and a need phase (session 2 must
// use it). Scenarios are evaluated by concrete assertions over the workspace,
// never by the agent's prose.

import type { CommandRunner } from '../exec';
import type { DriverModelRef, DriverTokenUsage, DriverToolCall } from '../opencode/driver';

/** Per-session outcome status, mirroring the A2 unit statuses. */
export type BSessionStatus = 'ok' | 'auth' | 'timeout' | 'contaminated' | 'error';

/** A child (sub-agent) session captured alongside its parent. */
export interface BChildResult {
  readonly sessionId: string;
  readonly finalText: string;
  readonly memoryCalls: number;
  readonly toolCalls: number;
  readonly tokens: DriverTokenUsage | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly steps: number;
  readonly finish: string | null;
  readonly error: string | null;
}

/** Everything one measured session produced (worker → parent contract). */
export interface BSessionOutcome {
  readonly status: BSessionStatus;
  readonly sessionId: string;
  readonly finalText: string;
  readonly toolCalls: readonly DriverToolCall[];
  readonly memoryCalls: number;
  readonly model: DriverModelRef | null;
  readonly tokens: DriverTokenUsage | null;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly steps: number;
  readonly finish: string | null;
  readonly error: string | null;
  readonly errorType: string | null;
  readonly isolationOk: boolean;
  readonly children: readonly BChildResult[];
  /** Raw transcript dump, kept for evidence. */
  readonly rawMessages: unknown;
}

/** A session outcome plus the prompt that produced it. */
export interface BSessionResult extends BSessionOutcome {
  readonly sessionIndex: number;
  readonly prompt: string;
}

export interface ScenarioSession {
  readonly prompt: string;
}

/** Inputs for a scenario's optional post-copy workspace preparation. */
export interface ScenarioPrepareContext {
  readonly workspaceDir: string;
}

/** Inputs for a scenario's optional data seed, run after the unit DB exists. */
export interface ScenarioSeedContext {
  readonly workspaceDir: string;
  /** Absolute path to the unit's Mind database, or null for no-memory. */
  readonly mindDb: string | null;
  /** Engine binary (the local checkout for `mind-current`), or null. */
  readonly mindBin: string | null;
  /** Isolated unit environment (includes RAG pointers and any credential). */
  readonly env: Record<string, string>;
  /** Command port bound to the workspace (runs with the workspace as cwd). */
  readonly run: CommandRunner;
}

/**
 * Capabilities a scenario needs before it can be executed meaningfully.
 *
 * `skill-first` means the current canonical skill-first activation, not merely
 * any installed skill: only the `mind-current` condition installs and exercises
 * the product's skill-first setup.
 */
export type ScenarioRequirement =
  | 'tier-maintenance'
  | 'semantic-recall'
  | 'mind-memory'
  | 'skill-first';

export interface ScenarioAssertionResult {
  readonly pass: boolean;
  readonly details: readonly string[];
}

/** Inputs an assertion may inspect. Assertions must not trust agent prose. */
export interface ScenarioAssertionContext {
  readonly workspaceDir: string;
  readonly sessionResults: readonly BSessionResult[];
  readonly childResults: readonly BChildResult[];
  readonly mindDb: string | null;
  /** Command port bound to the workspace (runs with the workspace as cwd). */
  readonly run: CommandRunner;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** Fixture directory, relative to the harness root (`benchmarks/agent-memory`). */
  readonly fixture: string;
  /**
   * Optional post-copy workspace preparation (e.g. rename a fixture file that
   * must not be discovered by a bare `bun test` into its final name). Runs once
   * after the fixture is copied and before any session executes.
   */
  prepare?(ctx: ScenarioPrepareContext): void;
  /**
   * Optional data seed, run after the fixture copy and the fresh DB init, and
   * before any session. B6/B7/B8/B10 use it to stage memories/links.
   */
  seed?(ctx: ScenarioSeedContext): void | Promise<void>;
  /**
   * Per-scenario RAG toggle (default false). Only `true` sets `MIND_RAG=true`
   * and the selected embedding provider/key in the isolated unit.
   */
  readonly rag?: boolean;
  /**
   * Capabilities the scenario needs. When one is unavailable (wrong engine,
   * missing credential) the runner records `not_run` with a reason instead of
   * failing the scenario.
   */
  readonly requires?: readonly ScenarioRequirement[];
  /**
   * Extra skills the fail-closed isolation gate must allow for this scenario.
   * When set, it replaces the built-in default, so list the built-ins too.
   */
  readonly allowedSkills?: readonly string[];
  readonly sessions: readonly ScenarioSession[];
  makeAssertion(
    ctx: ScenarioAssertionContext
  ): ScenarioAssertionResult | Promise<ScenarioAssertionResult>;
}
