// Scenario B5 — durable writing.
//
// Session 1 asks the agent to make a constrained persistence decision and
// preserve it for future sessions. Session 2 asks it to apply that decision.
//
// Design note: the assertion reads the unit's own Mind database through
// read-only inspectors, never the agent's prose. The decision is constrained so
// the stored memory must contain a known key-term set; any durable
// decision/pattern memory in a project space satisfies the contract. An
// optional link is reported but not required.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectAllLinks, inspectAllMemories } from '../../../mind/inspect';
import { duplicateMemoryNames } from '../../duplicates';
import type { Scenario, ScenarioAssertionContext, ScenarioAssertionResult } from '../../scenario';

/** Required literal phrase: the decided persistence path. */
export const B5_REQUIRED_PATH = 'storage/tasks.jsonl';
/** The format must be JSON Lines; either spelling is accepted. */
export const B5_JSONL_MARKERS = ['jsonl', 'json lines'] as const;
/** Timestamps must be UTC; the exact ISO spelling is left to the agent. */
export const B5_REQUIRED_TIMESTAMP_TERM = 'utc';

export const B5_CATEGORY_TAGS = ['cat:decision', 'cat:pattern'] as const;
/** Session-2 artifact proving the later session applied the stored decision. */
export const B5_APPLIED_FILE = 'applied.txt';

export const B5_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    'Read the project to understand how task data is currently stored.',
    '',
    'Decide how task persistence MUST work. The decision is constrained:',
    '- tasks are appended as JSON Lines (one JSON object per line) in a single file;',
    '- the file lives at `storage/tasks.jsonl`;',
    '- timestamps are stored as UTC ISO-8601 strings.',
    '',
    'Do NOT implement anything in this session. Preserve this decision as durable project knowledge so that a future session can apply it without asking again.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    'Implement task persistence following the decision that was already established for this project. Running `bun run export` must append the current tasks to the decided persistence file.',
    '',
    `Also write a short summary to \`${B5_APPLIED_FILE}\` in the current directory that names the storage path and the persistence format you applied.`,
  ].join('\n'),
];

function contentSatisfiesDecision(content: string): boolean {
  const folded = content.toLowerCase();
  return (
    folded.includes(B5_REQUIRED_PATH) &&
    B5_JSONL_MARKERS.some(marker => folded.includes(marker)) &&
    folded.includes(B5_REQUIRED_TIMESTAMP_TERM)
  );
}

function artifactSatisfiesDecision(content: string): boolean {
  const folded = content.toLowerCase();
  return (
    folded.includes(B5_REQUIRED_PATH) && B5_JSONL_MARKERS.some(marker => folded.includes(marker))
  );
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

  const candidates = projectMemories.filter(
    memory =>
      B5_CATEGORY_TAGS.some(tag => memory.tags.includes(tag)) &&
      contentSatisfiesDecision(memory.content)
  );

  if (projectMemories.length === 0) {
    details.push('no project memory found under projects/*');
  } else if (candidates.length === 0) {
    const tagged = projectMemories.filter(memory =>
      B5_CATEGORY_TAGS.some(tag => memory.tags.includes(tag))
    );
    details.push(
      tagged.length === 0
        ? 'no project memory carries a cat:decision or cat:pattern tag'
        : `none of the ${tagged.length} decision/pattern memor(ies) contains the decision key terms ` +
            `(${B5_REQUIRED_PATH}, JSON Lines, UTC)`
    );
  } else {
    details.push(
      `durable decision/pattern memory found: ` +
        candidates.map(memory => `${memory.space}/${memory.name}`).join(', ')
    );
  }

  // Atomicity: a decision is one memory, so the same name must not be stored twice
  // in the same space.
  const duplicates = duplicateMemoryNames(projectMemories);
  if (duplicates.length > 0) {
    details.push(`duplicate memory name(s) in project space: ${duplicates.join(', ')}`);
  } else {
    details.push('no duplicate memory names in project spaces');
  }

  // Optional: links are reported only when the agent created one.
  const candidateNames = new Set(candidates.map(memory => memory.name));
  const touchingLinks = inspectAllLinks(ctx.mindDb).filter(
    link => candidateNames.has(link.source) || candidateNames.has(link.target)
  );
  details.push(`links touching the decision memory: ${touchingLinks.length} (optional)`);

  // The later session must actually apply the stored decision: its artifact
  // names the storage path and the persistence format.
  let appliedOk = false;
  const appliedPath = join(ctx.workspaceDir, B5_APPLIED_FILE);
  if (!existsSync(appliedPath)) {
    details.push(`${B5_APPLIED_FILE} was not written`);
  } else {
    const applied = readFileSync(appliedPath, 'utf8');
    appliedOk = artifactSatisfiesDecision(applied);
    details.push(
      appliedOk
        ? `${B5_APPLIED_FILE} reflects the stored decision`
        : `${B5_APPLIED_FILE} does not name ${B5_REQUIRED_PATH} and JSON Lines`
    );
  }

  return {
    pass:
      projectMemories.length > 0 && candidates.length > 0 && duplicates.length === 0 && appliedOk,
    details,
  };
}

export const B5_SCENARIO: Scenario = {
  id: 'b5',
  title: 'Durable writing',
  fixture: 'fixtures/b5',
  // DB assertions need a Mind engine. B7/B9 will declare the same requirement.
  requires: ['mind-memory'],
  sessions: [{ prompt: B5_PROMPTS[0]! }, { prompt: B5_PROMPTS[1]! }],
  makeAssertion,
};
