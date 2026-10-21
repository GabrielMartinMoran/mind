// Capture the exact tool versions recorded in a run's `meta.json`.
//
// `opencode --version` is free (no LLM); the SDK version is read from the
// installed package, and Bun's version comes from the runtime. Every value is
// best-effort: a missing binary or package yields `null` rather than failing a
// run.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandRunner } from './exec';
import type { ToolVersions } from './run';

/**
 * Root of the harness subproject (`benchmarks/agent-memory`). This is where the
 * harness installs its own dependencies, including `@opencode/sdk`, so version
 * capture must look here instead of the repository root.
 */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extract a semver-ish version from `opencode --version` output. */
export function parseOpencodeVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z._-]+)?)/.exec(stdout);
  return match ? match[1]! : null;
}

/** Read the installed `@opencode/sdk` version, or `null` when absent. */
export function readSdkVersion(sdkRoot: string = HARNESS_ROOT): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(sdkRoot, 'node_modules/@opencode/sdk/package.json'), 'utf8')
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface CaptureVersionsOptions {
  /** Repository root; used as the working directory for the `opencode` probe. */
  readonly repoRoot: string;
  /**
   * Root that owns the harness dependencies. Defaults to the harness root so a
   * benchmark run reads the SDK installed next to it, not a stale root copy.
   */
  readonly sdkRoot?: string;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Capture the OpenCode/SDK/Bun versions for a run. The `opencode --version`
 * probe goes through the injected runner (a fake in tests), so this stays free
 * and offline.
 */
export async function captureToolVersions(
  runner: CommandRunner,
  options: CaptureVersionsOptions
): Promise<ToolVersions> {
  let opencode: string | null = null;
  try {
    const result = await runner({
      command: 'opencode',
      args: ['--version'],
      cwd: options.repoRoot,
      env: options.env,
    });
    opencode = parseOpencodeVersion(result.stdout) ?? parseOpencodeVersion(result.stderr);
  } catch {
    opencode = null;
  }
  return { opencode, sdk: readSdkVersion(options.sdkRoot), bun: Bun.version };
}
