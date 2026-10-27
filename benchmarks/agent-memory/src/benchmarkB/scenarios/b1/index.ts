// Scenario B1 — persistent architectural decision.
//
// Session 1 analyses the project and DECIDES how persistence must be
// implemented (constraints: Bun only, no new dependencies and no native
// binaries; data stored as files under `data/`; timestamps UTC ISO-8601), and
// must preserve the decision for a future session. Session 2 implements the
// `export` command in the same workspace.
//
// Design note: the session-1 constraints determine the single correct decision
// (a dependency-free, file-based JSON/JSONL store under `data/` with UTC
// timestamps); the assertion checks exactly that constraint set against the
// workspace — never the agent's prose.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Scenario, ScenarioAssertionContext, ScenarioAssertionResult } from '../../scenario';

/** A UTC ISO-8601 timestamp (`Z` or `+00:00`, optional fractional seconds). */
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

export const B1_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    'Read the project (README, source files, package.json).',
    '',
    'Decide how persistent storage MUST be implemented for this project. The decision is constrained:',
    '- it must run on Bun with NO new dependencies and no native binaries;',
    '- it must store data under a `data/` directory as files;',
    '- timestamps must be stored as UTC ISO-8601 strings.',
    '',
    'Do NOT modify any file in the repository in this session. Only analyze the project and make the decision. Preserve your decision so that a future session can implement it without asking you again.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    'Implement the `export` command so that running `bun run export` writes the current tasks to the project persistence layer, following the decision that was made for this project.',
  ].join('\n'),
];

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFilesUnder(path));
    else out.push(path);
  }
  return out;
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (DATE_PREFIX.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringValues(item, out);
    }
  }
}

/** All ISO-date-looking strings found in the persisted JSON/JSONL files. */
export function collectTimestamps(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const documents =
      path.endsWith('.jsonl') || path.endsWith('.ndjson')
        ? text
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
              try {
                return JSON.parse(line) as unknown;
              } catch {
                return null;
              }
            })
        : [
            (() => {
              try {
                return JSON.parse(text) as unknown;
              } catch {
                return null;
              }
            })(),
          ];
    for (const document of documents) collectStringValues(document, out);
  }
  return out;
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];
  let pass = true;

  // 1. No new dependencies (the decision constraint).
  const pkg = readJsonFile(join(ctx.workspaceDir, 'package.json'));
  const deps = {
    ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  const depNames = Object.keys(deps);
  if (depNames.length > 0) {
    pass = false;
    details.push(`new dependencies added: ${depNames.join(', ')}`);
  } else {
    details.push('no dependencies added');
  }

  // 2. The export command runs.
  const result = await ctx.run({ command: 'bun', args: ['run', 'export'] });
  if (result.exitCode !== 0) {
    pass = false;
    const output = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    details.push(`export command failed (exit ${result.exitCode}): ${output}`);
  } else {
    details.push('export command ran successfully');
  }

  // 3. Persistence is file-based JSON/JSONL under `data/`.
  const files = listFilesUnder(join(ctx.workspaceDir, 'data')).filter(path =>
    /\.(json|jsonl|ndjson)$/.test(path)
  );
  if (files.length === 0) {
    pass = false;
    details.push('no JSON/JSONL persistence file found under data/');
  } else {
    details.push(`${files.length} persistence file(s) found under data/`);
  }

  // 4. Timestamps are UTC ISO-8601.
  const timestamps = collectTimestamps(files);
  if (timestamps.length === 0) {
    pass = false;
    details.push('no UTC ISO-8601 timestamp found in persisted data');
  } else {
    const bad = timestamps.filter(value => !ISO_UTC_PATTERN.test(value));
    if (bad.length > 0) {
      pass = false;
      details.push(`non-UTC-ISO timestamp(s): ${bad.slice(0, 3).join(', ')}`);
    } else {
      details.push(`${timestamps.length} UTC ISO-8601 timestamp(s) verified`);
    }
  }

  return { pass, details };
}

export const B1_SCENARIO: Scenario = {
  id: 'b1',
  title: 'Persistent architectural decision',
  fixture: 'fixtures/b1',
  sessions: [{ prompt: B1_PROMPTS[0]! }, { prompt: B1_PROMPTS[1]! }],
  makeAssertion,
};
