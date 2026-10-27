// Thin wrapper around a pinned worktree's `mind` CLI.
//
// Every call runs the pinned binary under an explicit, non-shared environment
// (its own MIND_DATA_DIR / MIND_DB_PATH / MIND_SYNC_ROOT and an explicit
// MIND_RAG that follows the engine's `rag` option, off by default) so the
// benchmark never touches the user's live database, and captures
// stdout/stderr/exit code for evidence.

import { RAG_EMBEDDING_PROVIDER, type EmbeddingProviderId } from '../config';
import { runCommand, type CommandInvocation, type CommandRunner } from '../exec';

export interface MindPaths {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly syncRoot: string;
}

export class MindCliError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'MindCliError';
  }
}

export interface MindCliOptions {
  /** Absolute path to `<worktree>/mind`. */
  readonly bin: string;
  readonly paths: MindPaths;
  readonly cwd?: string;
  /** RAG is disabled for the benchmark by default; lexical search is deterministic. */
  readonly rag?: boolean;
  readonly runner?: CommandRunner;
  readonly baseEnv?: Record<string, string | undefined>;
}

export interface MindCliRunOptions {
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface MindCliResult {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function buildMindEnv(
  paths: MindPaths,
  baseEnv: Record<string, string | undefined> = process.env,
  rag = false,
  embeddingProvider: EmbeddingProviderId = RAG_EMBEDDING_PROVIDER
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    MIND_DATA_DIR: paths.dataDir,
    MIND_DB_PATH: paths.dbPath,
    MIND_SYNC_ROOT: paths.syncRoot,
    MIND_RAG: rag ? 'true' : 'false',
    ...(rag ? { MIND_EMBEDDING_PROVIDER: embeddingProvider } : {}),
  };
}

export class MindCli {
  private readonly options: MindCliOptions;

  constructor(options: MindCliOptions) {
    this.options = options;
  }

  get env(): Record<string, string | undefined> {
    return buildMindEnv(this.options.paths, this.options.baseEnv, this.options.rag);
  }

  async run(args: readonly string[], runOptions: MindCliRunOptions = {}): Promise<MindCliResult> {
    const invocation: CommandInvocation = {
      command: this.options.bin,
      args,
      cwd: this.options.cwd,
      env: this.env,
      timeoutMs: runOptions.timeoutMs,
      stdin: runOptions.stdin,
    };
    const runner = this.options.runner ?? runCommand;
    const result = await runner(invocation);
    return {
      args: [...args],
      env: invocation.env ?? {},
      cwd: invocation.cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  // Run and throw a typed error on a non-zero exit code.
  async exec(args: readonly string[], runOptions: MindCliRunOptions = {}): Promise<MindCliResult> {
    const result = await this.run(args, runOptions);
    if (result.exitCode !== 0) {
      throw new MindCliError(
        `mind ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim()}`,
        args,
        result.exitCode,
        result.stderr
      );
    }
    return result;
  }
}
