// Benchmark configuration: pinned versions, conditions, model, paths and
// limits. Every value here is either fixed by the approved plan or produced by
// the T1 platform probe; nothing is discovered at import time.

export type ConditionId = 'no-memory' | 'mind-v9' | 'mind-v10' | 'mind-current';

/**
 * Engine label. `v9` = `main`, `v10` = `develop` (user-facing rótulos).
 * `current` runs the local working-tree checkout (no pinned commit).
 */
export type EngineVersion = 'v9' | 'v10' | 'current';

/** Engines that are pinned to a git commit and prepared in their own worktree. */
export type PinnedEngineVersion = Exclude<EngineVersion, 'current'>;

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  /** Reasoning variant; `default` means "no variant" (provider default). */
  readonly variant?: string;
}

export interface PinnedVersion {
  readonly label: PinnedEngineVersion;
  /** Git commit pinned for this engine's worktree. */
  readonly ref: string;
  /** Expected SQLite `meta.schema_version` of the pinned engine. */
  readonly schemaVersion: number;
}

export const CONDITIONS: readonly ConditionId[] = [
  'no-memory',
  'mind-v9',
  'mind-v10',
  'mind-current',
];

/**
 * Conditions used when the CLI is given no explicit `--conditions`. `mind-current`
 * is opt-in: it runs the working tree and is the only condition that can prove
 * the new memory lifecycle capabilities.
 */
export const DEFAULT_CONDITIONS: readonly ConditionId[] = ['no-memory', 'mind-v9', 'mind-v10'];

/**
 * Pinned engine versions. Rótulos are the user's branch names:
 * `v9` = `main@36d2f1e` (schema 8, pre-multichannel engine);
 * `v10` = `develop@c7029b3` (schema 10, multichannel pipeline).
 */
export const PINNED_VERSIONS: Readonly<Record<PinnedEngineVersion, PinnedVersion>> = {
  v9: { label: 'v9', ref: '36d2f1e', schemaVersion: 8 },
  v10: { label: 'v10', ref: 'c7029b3', schemaVersion: 10 },
};

/**
 * Embedding provider used when a benchmark scenario asks for RAG. It mirrors
 * the authorized model provider so a single runtime credential
 * (`OPENROUTER_API_KEY`) covers both the agent and the embeddings request.
 */
export type EmbeddingProviderId = 'openai' | 'openrouter';
export const RAG_EMBEDDING_PROVIDER: EmbeddingProviderId = 'openrouter';

/** Env var each embedding provider reads; never printed or persisted. */
export function embeddingCredentialEnvVar(provider: EmbeddingProviderId): string {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
}

/**
 * The single authorized provider/model pair for a run. Never changed mid-run.
 *
 * Scope change (2026-10-18): the pilot now runs on **OpenRouter** with the same
 * DeepSeek V4.1 Flash model. The `opencode-go` pairing is kept below as an
 * alternative constant (its credential is paused) so switching back is a
 * one-line change.
 */
export const MODEL_OPENROUTER: ModelRef = {
  providerID: 'openrouter',
  id: 'deepseek/deepseek-v4.1-flash',
  variant: 'default',
};

/** The original (paused) provider/model pairing. Kept for reference. */
export const MODEL_OPENCODE_GO: ModelRef = {
  providerID: 'opencode-go',
  id: 'deepseek-v4.1-flash',
  variant: 'default',
};

export const MODEL: ModelRef = MODEL_OPENROUTER;

/**
 * Credential environment variable each known provider reads, as declared in
 * `~/.cache/opencode/models.json` (`<provider>.env`). Used to inject the
 * authorized key into the isolated child environment only.
 */
export const PROVIDER_CREDENTIAL_ENV: Readonly<Record<string, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
};

/** The credential env var for a model's provider, or `null` if unknown. */
export function credentialEnvVarFor(model: ModelRef): string | null {
  return PROVIDER_CREDENTIAL_ENV[model.providerID] ?? null;
}

export interface BenchmarkPaths {
  readonly runRoot: string;
  readonly workRoot: string;
}

export const DEFAULT_PATHS: BenchmarkPaths = {
  runRoot: 'benchmarks/agent-memory/runs',
  workRoot: 'benchmarks/agent-memory/.work',
};

export interface Limits {
  /** Maximum agent steps (messages) per session. */
  readonly sessionSteps: number;
  /** Per-invocation wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Hard cost cap in USD; `null` = refuse any paid stage. */
  readonly maxCostUsd: number | null;
}

export const DEFAULT_LIMITS: Limits = {
  sessionSteps: 30,
  timeoutMs: 600_000,
  maxCostUsd: null,
};

/** Built-in OpenCode skills present even in a fully isolated environment. */
export const BUILTIN_SKILLS: readonly string[] = ['opencode', 'report'];
/** Built-in OpenCode commands present even in a fully isolated environment. */
export const BUILTIN_COMMANDS: readonly string[] = ['init', 'review'];
/** Built-in OpenCode plugin id prefix; anything else is a user plugin leak. */
export const BUILTIN_PLUGIN_PREFIX = 'opencode.';

export interface DatasetSpec {
  readonly url: string;
  /** sha256 recorded per run; `null` until the dataset is fetched. */
  readonly expectedSha256: string | null;
}

export const DATASET: DatasetSpec = {
  url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
  // Pinned dataset hash (verified 2026-10-18, 2,805,274 bytes). A mismatch
  // fails loudly so a run is always reproducible; override per-run if upstream
  // re-publishes the file.
  expectedSha256: '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4',
};

/** Smoke budget cap referenced by the docs and the CLI refusal messages. */
export const SMOKE_BUDGET_USD = 0.05;
/** Approved pilot hard cap. */
export const PILOT_BUDGET_USD = 5;

/** Map a condition to the engine it exercises (`null` for `no-memory`). */
export function engineForCondition(condition: ConditionId): EngineVersion | null {
  if (condition === 'mind-v9') return 'v9';
  if (condition === 'mind-v10') return 'v10';
  if (condition === 'mind-current') return 'current';
  return null;
}

/** True for every condition that wires a Mind MCP server. */
export function isMindCondition(condition: ConditionId): boolean {
  return engineForCondition(condition) !== null;
}

export function isCondition(value: string): value is ConditionId {
  return (CONDITIONS as readonly string[]).includes(value);
}
