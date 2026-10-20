// Scenario B9 — cross-session continuity.
//
// Three sessions share the unit's isolated environment. Session 1 establishes a
// concrete project fact and is asked to leave a durable session summary; session
// 2 does a small related task and closes the same way; session 3 must use the
// preserved context and write an artifact.
//
// Design note: the assertion reads the unit's own Mind database through
// read-only inspectors (session summaries are memories tagged `type:session` +
// `cat:summary`) plus the workspace artifact — never the agent's prose.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectAllMemories,
  inspectSessionSummaries,
  type InspectedMemoryTags,
} from '../../../mind/inspect';
import { duplicateMemoryNames } from '../../duplicates';
import type { Scenario, ScenarioAssertionContext, ScenarioAssertionResult } from '../../scenario';

/** The concrete project fact the sessions must carry forward. */
export const B9_FACT_VERSION = '1.3';
export const B9_ARTIFACT_FILE = 'continuity.txt';

export const B9_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    `Review the project and establish this project fact: the minimum supported Bun version is ${B9_FACT_VERSION}.`,
    '',
    'Record the fact as durable project knowledge and leave a session summary for future sessions so that a later session can recover it.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    `Document the minimum supported Bun version in \`notes/build-requirements.md\`.`,
    '',
    'Close this session by leaving a session summary for future sessions.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    `Using the context left by previous sessions, write the minimum supported Bun version to \`${B9_ARTIFACT_FILE}\` in the current directory.`,
  ].join('\n'),
];

interface SpacedSummary extends InspectedMemoryTags {
  readonly space: string;
}

function collectSessionSummaries(dbPath: string, spaces: readonly string[]): SpacedSummary[] {
  return spaces.flatMap(space =>
    inspectSessionSummaries(dbPath, space).map(summary => ({ ...summary, space }))
  );
}

function summaryContent(
  memories: ReturnType<typeof inspectAllMemories>,
  summary: SpacedSummary
): string {
  const memory = memories.find(
    candidate => candidate.space === summary.space && candidate.name === summary.name
  );
  return memory?.content ?? '';
}

function contentCarriesFact(content: string): boolean {
  return content.includes(B9_FACT_VERSION);
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];

  if (!ctx.mindDb || !existsSync(ctx.mindDb)) {
    return { pass: false, details: ['no Mind database available for this unit'] };
  }

  const allMemories = inspectAllMemories(ctx.mindDb);
  const spaces = [...new Set(allMemories.map(memory => memory.space))];
  const summaries = collectSessionSummaries(ctx.mindDb, spaces);
  const factSummaries = summaries.filter(summary =>
    contentCarriesFact(summaryContent(allMemories, summary))
  );

  if (summaries.length === 0) {
    details.push('no session summary memory found (tags type:session + cat:summary)');
  } else {
    details.push(
      `session summaries found: ` +
        summaries.map(summary => `${summary.space}/${summary.name} (T${summary.tier})`).join(', ')
    );
  }

  if (factSummaries.length === 0) {
    details.push(`no session summary contains the Bun ${B9_FACT_VERSION} fact`);
  } else {
    details.push(
      `fact-bearing session summary found: ` +
        factSummaries
          .map(summary => `${summary.space}/${summary.name} (T${summary.tier})`)
          .join(', ')
    );
  }

  const duplicates = duplicateMemoryNames(summaries);
  if (duplicates.length > 0) {
    details.push(`duplicate session summary name(s): ${duplicates.join(', ')}`);
  } else {
    details.push('no duplicate session summary names');
  }

  let artifactOk = false;
  const artifactPath = join(ctx.workspaceDir, B9_ARTIFACT_FILE);
  if (!existsSync(artifactPath)) {
    details.push(`${B9_ARTIFACT_FILE} was not written`);
  } else {
    artifactOk = contentCarriesFact(readFileSync(artifactPath, 'utf8'));
    details.push(
      artifactOk
        ? `${B9_ARTIFACT_FILE} carries the preserved fact`
        : `${B9_ARTIFACT_FILE} does not contain the Bun ${B9_FACT_VERSION} fact`
    );
  }

  return {
    pass: factSummaries.length > 0 && duplicates.length === 0 && artifactOk,
    details,
  };
}

export const B9_SCENARIO: Scenario = {
  id: 'b9',
  title: 'Cross-session continuity',
  fixture: 'fixtures/b9',
  requires: ['mind-memory'],
  sessions: [{ prompt: B9_PROMPTS[0]! }, { prompt: B9_PROMPTS[1]! }, { prompt: B9_PROMPTS[2]! }],
  makeAssertion,
};
