// Scenario B8 — tier maintenance (pinning + promotion).
//
// The unit starts with two existing T2 project memories: an operationally
// critical `release-checklist` (`cat:decision`) and a `background-notes`
// reference (`cat:discovery`). Session 1 asks the agent to distinguish active
// knowledge from reference material: pin the checklist and move it to the
// active tier, leaving the background notes untouched. Session 2 uses the
// checklist and writes `tier-plan.txt`.
//
// Design note: seeding goes through the isolated `mind` CLI/env (never direct
// SQL, never the live database). The assertion reads the unit's own Mind
// database through read-only inspectors plus the workspace artifact — never the
// agent's prose.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectAllMemories } from '../../../mind/inspect';
import { duplicateMemoryNames } from '../../duplicates';
import type {
  Scenario,
  ScenarioAssertionContext,
  ScenarioAssertionResult,
  ScenarioSeedContext,
} from '../../scenario';

export const B8_SPACE = 'projects/b8-app';
export const B8_CHECKLIST = 'release-checklist';
export const B8_BACKGROUND = 'background-notes';
export const B8_CHECKLIST_TAG = 'cat:decision';
export const B8_BACKGROUND_TAG = 'cat:discovery';
export const B8_CHECKLIST_CONTENT =
  'Release checklist: 1) run bun test; 2) run bun run build; ' +
  '3) update CHANGELOG.md; 4) tag the release with the version.';
export const B8_BACKGROUND_CONTENT =
  'Background notes: releasetool began as an internal experiment; early prototypes ' +
  'used a shell script before the project moved to Bun.';
export const B8_ARTIFACT_FILE = 'tier-plan.txt';
/** The first checklist step the later session must recover. */
export const B8_CHECKLIST_FIRST_COMMAND = 'bun test';
export const B8_ACTIVE_TIER = 1;
export const B8_REFERENCE_TIER = 2;

export const B8_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    `Review the two project memories \`${B8_CHECKLIST}\` and \`${B8_BACKGROUND}\`.`,
    '',
    `The release checklist has become operationally critical: pin it and move it to the active tier (tier ${B8_ACTIVE_TIER}).`,
    `Leave \`${B8_BACKGROUND}\` as reference material and do not promote it.`,
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    `Using the \`${B8_CHECKLIST}\`, answer this question: which command must be run first before building or tagging a release?`,
    '',
    `Write the answer and the name of the checklist memory to \`${B8_ARTIFACT_FILE}\` in the current directory.`,
    `Leave \`${B8_BACKGROUND}\` as reference material and do not promote it.`,
  ].join('\n'),
];

/** Seed the two T2 memories through the isolated CLI. */
export async function seedB8(ctx: ScenarioSeedContext): Promise<void> {
  if (!ctx.mindBin || !ctx.mindDb) return;

  // Merge the host env for PATH/interpreter lookup; the isolated MIND_* pointers
  // and HOME/XDG overrides in `ctx.env` always win, so the live DB is never used.
  const env: Record<string, string | undefined> = { ...process.env, ...ctx.env };
  const run = (args: readonly string[]) => ctx.run({ command: ctx.mindBin!, args, env });

  const mustRun = async (args: readonly string[]): Promise<void> => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(`B8 seed failed (mind ${args.join(' ')}): ${result.stderr.trim()}`);
    }
  };

  await mustRun(['create', B8_SPACE, 'Release tooling benchmark fixture project']);
  await mustRun([
    'add',
    B8_SPACE,
    B8_CHECKLIST,
    B8_CHECKLIST_CONTENT,
    '--tags',
    B8_CHECKLIST_TAG,
    '--tier',
    String(B8_REFERENCE_TIER),
  ]);
  await mustRun([
    'add',
    B8_SPACE,
    B8_BACKGROUND,
    B8_BACKGROUND_CONTENT,
    '--tags',
    B8_BACKGROUND_TAG,
    '--tier',
    String(B8_REFERENCE_TIER),
  ]);
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];

  if (!ctx.mindDb || !existsSync(ctx.mindDb)) {
    return { pass: false, details: ['no Mind database available for this unit'] };
  }

  const projectMemories = inspectAllMemories(ctx.mindDb).filter(memory =>
    memory.space.startsWith('projects/')
  );

  const checklist = projectMemories.find(memory => memory.name === B8_CHECKLIST);
  let checklistOk = false;
  if (!checklist) {
    details.push(`release checklist memory '${B8_CHECKLIST}' is missing`);
  } else {
    const tierOk = checklist.tier === B8_ACTIVE_TIER;
    const pinnedOk = checklist.pinned;
    checklistOk = tierOk && pinnedOk;
    if (!tierOk) {
      details.push(
        `release checklist is at tier ${checklist.tier}, expected tier ${B8_ACTIVE_TIER}`
      );
    } else {
      details.push(`release checklist is at the active tier (T${B8_ACTIVE_TIER})`);
    }
    if (!pinnedOk) {
      details.push('release checklist is not pinned');
    } else {
      details.push('release checklist is pinned');
    }
  }

  const background = projectMemories.find(memory => memory.name === B8_BACKGROUND);
  let backgroundOk = false;
  if (!background) {
    details.push(`background notes memory '${B8_BACKGROUND}' is missing`);
  } else {
    const tierOk = background.tier === B8_REFERENCE_TIER;
    const pinnedOk = !background.pinned;
    backgroundOk = tierOk && pinnedOk;
    if (!tierOk) {
      details.push(
        `background notes were promoted to tier ${background.tier} ` +
          `(must stay tier ${B8_REFERENCE_TIER})`
      );
    } else {
      details.push(`background notes remain at tier ${B8_REFERENCE_TIER}`);
    }
    if (!pinnedOk) {
      details.push('background notes are pinned (must stay unpinned)');
    } else {
      details.push('background notes are not pinned');
    }
  }

  const duplicates = duplicateMemoryNames(projectMemories);
  if (duplicates.length > 0) {
    details.push(`duplicate memory name(s) in project space: ${duplicates.join(', ')}`);
  } else {
    details.push('no duplicate memory names in project spaces');
  }

  let artifactOk = false;
  const artifactPath = join(ctx.workspaceDir, B8_ARTIFACT_FILE);
  if (!existsSync(artifactPath)) {
    details.push(`${B8_ARTIFACT_FILE} was not written`);
  } else {
    const artifact = readFileSync(artifactPath, 'utf8');
    artifactOk = artifact.toLowerCase().includes(B8_CHECKLIST);
    details.push(
      artifactOk
        ? `${B8_ARTIFACT_FILE} names the release checklist`
        : `${B8_ARTIFACT_FILE} does not name ${B8_CHECKLIST}`
    );
  }

  return {
    pass: checklistOk && backgroundOk && duplicates.length === 0 && artifactOk,
    details,
  };
}

export const B8_SCENARIO: Scenario = {
  id: 'b8',
  title: 'Tier maintenance (pinning and promotion)',
  fixture: 'fixtures/b8',
  // DB/tier assertions need a Mind engine; memory_update provides pin/promote.
  requires: ['mind-memory'],
  seed: seedB8,
  sessions: [{ prompt: B8_PROMPTS[0]! }, { prompt: B8_PROMPTS[1]! }],
  makeAssertion,
};
