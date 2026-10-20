// Capture the exact tool versions recorded in a run's `meta.json`.
//
// `opencode --version` is free (no LLM); the SDK version is read from the
// installed package, and Bun's version comes from the runtime. Every value is
// best-effort: a missing binary or package yields `null` rather than failing a
// run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandRunner } from './exec';
import type { ToolVersions } from './run';

/** Extract a semver-ish version from `opencode --version` output. */
export function parseOpencodeVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z._-]+)?)/.exec(stdout);
  return match ? match[1]! : null;
}

/** Read the installed `@opencode/sdk` version, or `null` when absent. */
export function readSdkVersion(repoRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules/@opencode/sdk/package.json'), 'utf8')
    ) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface CaptureVersionsOptions {
  readonly repoRoot: string;
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
  return { opencode, sdk: readSdkVersion(options.repoRoot), bun: Bun.version };
}
