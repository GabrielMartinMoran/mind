// Scenario B7 — decision change / supersession.
//
// The unit starts with one seeded durable decision memory in a project space
// (`cat:decision`). Session 1 asks the agent to replace the decision while
// preserving the historical one and linking the change; session 2 asks it to
// apply the new decision and write an artifact.
//
// Design note: seeding goes through the isolated `mind` CLI/env (never direct
// SQL, never the live database). The assertion reads the unit's own Mind
// database through read-only inspectors plus the workspace artifact — never the
// agent's prose. The new memory name is NOT required; only its tags, content,
// link direction/label and the artifact are checked.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectAllLinks, inspectAllMemories } from '../../../mind/inspect';
import { duplicateMemoryNames } from '../../duplicates';
import type {
  Scenario,
  ScenarioAssertionContext,
  ScenarioAssertionResult,
  ScenarioSeedContext,
} from '../../scenario';

export const B7_SPACE = 'projects/b7-app';
export const B7_OLD_NAME = 'task-storage-decision';
export const B7_OLD_CONTENT = 'Tasks are persisted in a single SQLite database at data/tasks.db.';
export const B7_OLD_CATEGORY_TAG = 'cat:decision';

/** The replacement decision the agent must record. */
export const B7_NEW_PATH = 'storage/tasks.jsonl';
export const B7_JSONL_MARKERS = ['jsonl', 'json lines'] as const;
export const B7_NEW_TIMESTAMP_TERM = 'utc';
export const B7_LINK_LABEL = 'contradicts';
export const B7_ARTIFACT_FILE = 'decision.txt';

/** The historical memory must be explicitly marked superseded. */
export const B7_SUPERSEDED_TAG = 'status:superseded';

export const B7_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    `The project's durable decision \`${B7_OLD_NAME}\` says tasks are persisted in a single SQLite database at \`data/tasks.db\`.`,
    '',
    `The project has now decided to REPLACE that decision: tasks must be persisted as JSON Lines (one JSON object per line) in \`${B7_NEW_PATH}\`, with timestamps stored as UTC ISO-8601 strings.`,
    '',
    'Update the durable project knowledge:',
    '- preserve the historical decision instead of deleting it;',
    '- mark the historical memory as superseded;',
    '- record the new decision;',
    `- link the new decision memory to the historical memory with the label \`${B7_LINK_LABEL}\`.`,
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    `Using the current project decision, write a short summary to \`${B7_ARTIFACT_FILE}\` in the current directory that names the persistence format and the file path the project now uses.`,
  ].join('\n'),
];

function hasCategoryTag(tags: readonly string[]): boolean {
  return tags.some(tag => tag.startsWith('cat:'));
}

function contentSatisfiesNewDecision(content: string): boolean {
  const folded = content.toLowerCase();
  return (
    folded.includes(B7_NEW_PATH) &&
    B7_JSONL_MARKERS.some(marker => folded.includes(marker)) &&
    folded.includes(B7_NEW_TIMESTAMP_TERM)
  );
}

function artifactSatisfiesNewDecision(content: string): boolean {
  const folded = content.toLowerCase();
  return folded.includes(B7_NEW_PATH) && B7_JSONL_MARKERS.some(marker => folded.includes(marker));
}

/** The historical memory must still carry the seeded decision text. */
function preservesHistoricalContent(content: string): boolean {
  return content.includes(B7_OLD_CONTENT);
}

/** Seed the historical decision through the isolated CLI. */
export async function seedB7(ctx: ScenarioSeedContext): Promise<void> {
  if (!ctx.mindBin || !ctx.mindDb) return;

  // Merge the host env for PATH/interpreter lookup; the isolated MIND_* pointers
  // and HOME/XDG overrides in `ctx.env` always win, so the live DB is never used.
  const env: Record<string, string | undefined> = { ...process.env, ...ctx.env };
  const run = (args: readonly string[]) => ctx.run({ command: ctx.mindBin!, args, env });

  const mustRun = async (args: readonly string[]): Promise<void> => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(`B7 seed failed (mind ${args.join(' ')}): ${result.stderr.trim()}`);
    }
  };

  await mustRun(['create', B7_SPACE, 'Task queue benchmark fixture project']);
  await mustRun(['add', B7_SPACE, B7_OLD_NAME, B7_OLD_CONTENT, '--tags', B7_OLD_CATEGORY_TAG]);
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];

  if (!ctx.mindDb || !existsSync(ctx.mindDb)) {
    return { pass: false, details: ['no Mind database available for this unit'] };
  }

  const memories = inspectAllMemories(ctx.mindDb);
  const projectMemories = memories.filter(memory => memory.space.startsWith('projects/'));
  const links = inspectAllLinks(ctx.mindDb);

  const old = projectMemories.find(memory => memory.name === B7_OLD_NAME);
  let oldOk = false;
  if (!old) {
    details.push(`historical decision memory '${B7_OLD_NAME}' is missing`);
  } else {
    const hasCategory = old.tags.includes(B7_OLD_CATEGORY_TAG);
    const isSuperseded = old.tags.includes(B7_SUPERSEDED_TAG);
    const contentPreserved = preservesHistoricalContent(old.content);
    oldOk = hasCategory && isSuperseded && contentPreserved;
    if (!hasCategory) {
      details.push(`historical memory lost its '${B7_OLD_CATEGORY_TAG}' tag`);
    } else {
      details.push(`historical memory kept '${B7_OLD_CATEGORY_TAG}'`);
    }
    if (!isSuperseded) {
      details.push(
        `historical memory is not marked '${B7_SUPERSEDED_TAG}' ` +
          `(found tags: ${old.tags.join(', ') || 'none'})`
      );
    } else {
      details.push(`historical memory marked '${B7_SUPERSEDED_TAG}'`);
    }
    if (!contentPreserved) {
      details.push('historical memory content was overwritten instead of preserved');
    } else {
      details.push('historical memory content preserved');
    }
  }

  const newCandidates = projectMemories.filter(
    memory =>
      memory.name !== B7_OLD_NAME &&
      hasCategoryTag(memory.tags) &&
      contentSatisfiesNewDecision(memory.content)
  );
  if (newCandidates.length === 0) {
    details.push(
      `no new category-tagged memory records the replacement decision ` +
        `(${B7_NEW_PATH}, JSON Lines, UTC)`
    );
  } else {
    details.push(
      `replacement decision memory found: ${newCandidates.map(memory => memory.name).join(', ')}`
    );
  }

  const correctLink = newCandidates.find(candidate =>
    links.some(
      link =>
        link.source === candidate.name &&
        link.target === B7_OLD_NAME &&
        link.label === B7_LINK_LABEL
    )
  );
  if (correctLink) {
    details.push(`expected link stored: ${correctLink.name} → ${B7_OLD_NAME} [${B7_LINK_LABEL}]`);
  } else {
    const reversed = links.find(
      link =>
        link.label === B7_LINK_LABEL &&
        link.source === B7_OLD_NAME &&
        newCandidates.some(candidate => candidate.name === link.target)
    );
    if (reversed) {
      details.push(`wrong direction: ${B7_OLD_NAME} → ${reversed.target} [${B7_LINK_LABEL}]`);
    } else {
      const anyLabel = links.find(
        link =>
          link.target === B7_OLD_NAME &&
          newCandidates.some(candidate => candidate.name === link.source)
      );
      details.push(
        anyLabel
          ? `replacement → historical link has label '${anyLabel.label}', expected '${B7_LINK_LABEL}'`
          : `expected link missing: replacement → ${B7_OLD_NAME} [${B7_LINK_LABEL}]`
      );
    }
  }

  const duplicates = duplicateMemoryNames(projectMemories);
  if (duplicates.length > 0) {
    details.push(`duplicate memory name(s) in project space: ${duplicates.join(', ')}`);
  } else {
    details.push('no duplicate memory names in project spaces');
  }

  let artifactOk = false;
  const artifactPath = join(ctx.workspaceDir, B7_ARTIFACT_FILE);
  if (!existsSync(artifactPath)) {
    details.push(`${B7_ARTIFACT_FILE} was not written`);
  } else {
    artifactOk = artifactSatisfiesNewDecision(readFileSync(artifactPath, 'utf8'));
    details.push(
      artifactOk
        ? `${B7_ARTIFACT_FILE} names the new decision`
        : `${B7_ARTIFACT_FILE} does not name ${B7_NEW_PATH} and JSON Lines`
    );
  }

  return {
    pass:
      oldOk &&
      newCandidates.length > 0 &&
      Boolean(correctLink) &&
      duplicates.length === 0 &&
      artifactOk,
    details,
  };
}

export const B7_SCENARIO: Scenario = {
  id: 'b7',
  title: 'Decision change / supersession',
  fixture: 'fixtures/b7',
  requires: ['mind-memory'],
  seed: seedB7,
  sessions: [{ prompt: B7_PROMPTS[0]! }, { prompt: B7_PROMPTS[1]! }],
  makeAssertion,
};
