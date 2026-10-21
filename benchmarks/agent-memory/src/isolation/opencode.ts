// Isolated environment and OpenCode config for one condition.
//
// The recipe is the one proven by the T1 platform probe: a temp HOME plus
// XDG_{CONFIG,DATA,STATE,CACHE}_HOME under the condition directory, a private
// OPENCODE_DB, all `OPENCODE_DISABLE_*` guards, and an inline
// `OPENCODE_CONFIG_CONTENT` that pins the authorized model and (for the Mind
// conditions) exactly one `mind` MCP server. The private XDG_STATE_HOME keeps
// OpenCode from reusing the user's shared background service.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { MODEL, engineForCondition, type ConditionId, type EmbeddingProviderId } from '../config';

export interface IsolationDirs {
  readonly conditionDir: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly opencodeDb: string;
  readonly workspace: string;
  readonly mindDb: string;
  readonly mindDataDir: string;
  readonly syncRoot: string;
}

export function isolationDirs(conditionDir: string): IsolationDirs {
  const opencodeDir = join(conditionDir, 'opencode');
  return {
    conditionDir,
    home: join(opencodeDir, 'home'),
    config: join(opencodeDir, 'config'),
    data: join(opencodeDir, 'data'),
    state: join(opencodeDir, 'state'),
    cache: join(opencodeDir, 'cache'),
    opencodeDb: join(opencodeDir, 'data', 'opencode.db'),
    workspace: join(conditionDir, 'workspace'),
    mindDb: join(conditionDir, 'mind.db'),
    mindDataDir: conditionDir,
    syncRoot: join(conditionDir, 'syncroot'),
  };
}

/**
 * Create the isolated directory tree for a condition or the judge before
 * OpenCode is spawned. The background service `chdir`s into `HOME`, so that
 * directory (plus the XDG roots and the workspace) must exist or every CLI/SDK
 * call fails with `ENOENT` before any prompt is sent.
 */
export function ensureIsolationDirs(dir: IsolationDirs): void {
  for (const path of [dir.home, dir.config, dir.data, dir.state, dir.cache, dir.workspace]) {
    mkdirSync(path, { recursive: true });
  }
}

export interface ConditionIsolationInput {
  readonly condition: ConditionId;
  readonly dir: IsolationDirs;
  /** Path to the engine's `mind` script; required for Mind conditions. */
  readonly mindBin: string | null;
  /** Per-scenario RAG toggle. Off by default so lexical runs stay deterministic. */
  readonly rag?: boolean;
  /** Embedding provider used only when `rag` is true. */
  readonly embeddingProvider?: EmbeddingProviderId;
  /**
   * Optional permission ruleset merged into the config. The `judge` profile
   * uses a deny-all tool rule so an evaluator session cannot wander.
   */
  readonly permissions?: readonly PermissionRule[];
}

interface MindMcpServer {
  readonly type: 'local';
  readonly command: readonly string[];
  readonly environment: Record<string, string>;
}

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: 'allow' | 'deny' | 'ask';
}

interface OpenCodeConfig {
  readonly $schema: string;
  readonly model: string;
  readonly mcp?: { readonly servers: Record<string, MindMcpServer> };
  readonly permissions?: readonly PermissionRule[];
  readonly providers?: Record<string, unknown>;
}

/**
 * Temperature is requested at provider/model `body` scope; OpenCode forwards
 * provider `body` params to the request. The provider may ignore it — the
 * benchmark records `temperature_requested` and never blocks on it.
 */
const REQUESTED_TEMPERATURE = 0;

function providerTemperatureBody(): Record<string, unknown> {
  return {
    [MODEL.providerID]: {
      models: {
        [MODEL.id]: { body: { temperature: REQUESTED_TEMPERATURE } },
      },
    },
  };
}

export class IsolationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationConfigError';
  }
}

/** Mind data/sync pointers shared by the child env and the MCP server env. */
function mindPointerEnv(input: ConditionIsolationInput): Record<string, string> {
  const env: Record<string, string> = {
    MIND_DB_PATH: input.dir.mindDb,
    MIND_DATA_DIR: input.dir.mindDataDir,
    MIND_SYNC_ROOT: input.dir.syncRoot,
    MIND_RAG: input.rag ? 'true' : 'false',
  };
  if (input.rag && input.embeddingProvider) {
    env.MIND_EMBEDDING_PROVIDER = input.embeddingProvider;
  }
  return env;
}

// Non-secret environment overrides; the caller merges these over `process.env`
// (or a minimal base) when spawning OpenCode. No credential is included here —
// provider keys are injected only through the child environment for paid stages.
//
// The top-level MIND_* pointers matter even for assertions/seed commands that
// run the `mind` CLI with the workspace as cwd: without MIND_SYNC_ROOT the CLI
// would discover the repository's `.mind/config.yml` and touch autosync state
// outside the unit directory.
export function buildOpenCodeEnv(input: ConditionIsolationInput): Record<string, string> {
  return {
    HOME: input.dir.home,
    XDG_CONFIG_HOME: input.dir.config,
    XDG_DATA_HOME: input.dir.data,
    XDG_STATE_HOME: input.dir.state,
    XDG_CACHE_HOME: input.dir.cache,
    OPENCODE_DB: input.dir.opencodeDb,
    ...mindPointerEnv(input),
    OPENCODE_CONFIG_CONTENT: buildConfigContent(input),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
  };
}

export function buildConfigContent(input: ConditionIsolationInput): string {
  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model: `${MODEL.providerID}/${MODEL.id}`,
    providers: providerTemperatureBody(),
  };
  const withPermissions = (base: OpenCodeConfig): OpenCodeConfig =>
    input.permissions ? { ...base, permissions: input.permissions } : base;

  const version = engineForCondition(input.condition);
  if (version === null) {
    if (input.mindBin !== null) {
      throw new IsolationConfigError(
        `condition '${input.condition}' must not define a mind binary`
      );
    }
    return `${JSON.stringify(withPermissions(config), null, 2)}\n`;
  }

  if (!input.mindBin) {
    throw new IsolationConfigError(`condition '${input.condition}' requires a mind binary path`);
  }

  const mindServer: MindMcpServer = {
    type: 'local',
    command: [input.mindBin, 'mcp'],
    environment: mindPointerEnv(input),
  };

  return `${JSON.stringify(
    withPermissions({ ...config, mcp: { servers: { mind: mindServer } } }),
    null,
    2
  )}\n`;
}

/** The requested sampling temperature (0) recorded with every A2 measurement. */
export const TEMPERATURE_REQUESTED = REQUESTED_TEMPERATURE;

/** Concrete Mind database pointers for one measurement unit. */
export interface MindDatabasePointers {
  readonly dbPath: string;
  readonly dataDir: string;
  readonly syncRoot: string;
}

/**
 * Return a copy of a condition environment whose Mind pointers target a
 * specific database copy.
 *
 * The per-question isolation copy is only real when BOTH the child process and
 * the `mind` MCP server read it. This overrides the top-level
 * `MIND_DB_PATH`/`MIND_DATA_DIR`/`MIND_SYNC_ROOT` in the child environment AND
 * the matching `environment` block of the `mind` server inside
 * `OPENCODE_CONFIG_CONTENT`. A `no-memory` environment (no `mind` server) is
 * returned with only the top-level pointers set, which is harmless because that
 * condition defines no MCP server.
 */
export function applyMindDatabase(
  env: Record<string, string>,
  pointers: MindDatabasePointers
): Record<string, string> {
  const next: Record<string, string> = {
    ...env,
    MIND_DB_PATH: pointers.dbPath,
    MIND_DATA_DIR: pointers.dataDir,
    MIND_SYNC_ROOT: pointers.syncRoot,
  };
  const content = env.OPENCODE_CONFIG_CONTENT;
  if (!content) return next;
  let parsed: OpenCodeConfig;
  try {
    parsed = JSON.parse(content) as OpenCodeConfig;
  } catch {
    // An unparseable config is left untouched; the fail-closed isolation gate
    // rejects it before any paid prompt.
    return next;
  }
  const mind = parsed.mcp?.servers?.mind;
  if (!mind) return next;
  next.OPENCODE_CONFIG_CONTENT = `${JSON.stringify(
    {
      ...parsed,
      mcp: {
        servers: {
          ...parsed.mcp?.servers,
          mind: {
            ...mind,
            environment: {
              ...mind.environment,
              MIND_DB_PATH: pointers.dbPath,
              MIND_DATA_DIR: pointers.dataDir,
              MIND_SYNC_ROOT: pointers.syncRoot,
            },
          },
        },
      },
    },
    null,
    2
  )}\n`;
  return next;
}

// Fallback CLI flag for the `opencode run` driver path: a private server that
// never reuses the user's shared background service.
export function standaloneFlags(): string[] {
  return ['--standalone'];
}
