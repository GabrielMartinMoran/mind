// Scenario B10 — semantic recall (paraphrase-only).
//
// Two memories are seeded in a project space with RAG enabled: a target fact
// about credential rotation and a plausible but wrong distractor. A single
// session asks a natural paraphrase question whose key terms do not appear in
// the target content, so only semantic retrieval can answer it. The agent writes
// the answer to `recall.txt`.
//
// Design note: the seed runs through the isolated `mind` CLI/env (never direct
// SQL, never the live database) and therefore needs a live embedding provider.
// The scenario declares `rag: true` + `requires: ['mind-memory',
// 'semantic-recall']`, so the runner records it `not_run` (zero sessions, zero
// failures) when RAG, a Mind condition or the embedding credential is missing.
// The assertion reads the unit's own database through read-only inspectors plus
// the workspace artifact — never the agent's prose.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectAllMemories, inspectEmbeddingCoverage } from '../../../mind/inspect';
import { duplicateMemoryNames } from '../../duplicates';
import type {
  Scenario,
  ScenarioAssertionContext,
  ScenarioAssertionResult,
  ScenarioSeedContext,
} from '../../scenario';

export const B10_SPACE = 'projects/b10-app';
export const B10_TARGET = 'release-key-rotation';
export const B10_TARGET_CONTENT = 'Deployments rotate cryptographic keys every 24 hours.';
export const B10_DISTRACTOR = 'release-rollout-strategy';
export const B10_DISTRACTOR_CONTENT = 'Deployments use blue-green rollouts.';
export const B10_ARTIFACT_FILE = 'recall.txt';
/** The target fact fragment the artifact must carry. */
export const B10_ANSWER_TERMS = ['24', 'hours'] as const;
/** Markers that identify an answer copied from the distractor memory. */
export const B10_DISTRACTOR_MARKERS = ['blue-green', 'blue green', 'rollout'] as const;

export const B10_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    'How frequently are release credentials renewed?',
    '',
    `Write the answer to \`${B10_ARTIFACT_FILE}\` in the current directory.`,
  ].join('\n'),
];

function carriesTargetFact(content: string): boolean {
  const folded = content.toLowerCase();
  return B10_ANSWER_TERMS.every(term => folded.includes(term));
}

function carriesDistractorFact(content: string): boolean {
  const folded = content.toLowerCase();
  return B10_DISTRACTOR_MARKERS.some(marker => folded.includes(marker));
}

/** Seed both memories through the isolated CLI with RAG enabled. */
export async function seedB10(ctx: ScenarioSeedContext): Promise<void> {
  if (!ctx.mindBin || !ctx.mindDb) return;
  if (ctx.env.MIND_RAG !== 'true') {
    throw new Error('B10 seed requires RAG to be enabled so embeddings are generated');
  }

  // Merge the host env for PATH/interpreter lookup; the isolated MIND_* pointers
  // and HOME/XDG overrides in `ctx.env` always win, so the live DB is never used.
  const env: Record<string, string | undefined> = { ...process.env, ...ctx.env };
  const run = (args: readonly string[]) => ctx.run({ command: ctx.mindBin!, args, env });

  const mustRun = async (args: readonly string[]): Promise<void> => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(`B10 seed failed (mind ${args.join(' ')}): ${result.stderr.trim()}`);
    }
  };

  await mustRun(['create', B10_SPACE, 'Deployment tooling benchmark fixture project']);
  await mustRun(['add', B10_SPACE, B10_TARGET, B10_TARGET_CONTENT, '--tags', 'cat:decision']);
  await mustRun([
    'add',
    B10_SPACE,
    B10_DISTRACTOR,
    B10_DISTRACTOR_CONTENT,
    '--tags',
    'cat:pattern',
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

  const target = projectMemories.find(memory => memory.name === B10_TARGET);
  let targetOk = false;
  if (!target) {
    details.push(`target memory '${B10_TARGET}' is missing`);
  } else {
    const contentOk = carriesTargetFact(target.content);
    const coverage = inspectEmbeddingCoverage(ctx.mindDb, target.space, [B10_TARGET]);
    const embeddingOk = coverage[0]?.hasEmbedding === true;
    targetOk = contentOk && embeddingOk;
    if (!contentOk) {
      details.push(`target memory '${B10_TARGET}' does not contain the seeded fact`);
    } else {
      details.push(`target memory '${B10_TARGET}' contains the seeded fact`);
    }
    if (!embeddingOk) {
      details.push(`target memory '${B10_TARGET}' has no embedding (RAG did not index it)`);
    } else {
      details.push(`target memory '${B10_TARGET}' has an embedding`);
    }
  }

  const distractor = projectMemories.find(memory => memory.name === B10_DISTRACTOR);
  if (!distractor) {
    details.push(`distractor memory '${B10_DISTRACTOR}' is missing`);
  }

  const duplicates = duplicateMemoryNames(projectMemories);
  if (duplicates.length > 0) {
    details.push(`duplicate memory name(s) in project space: ${duplicates.join(', ')}`);
  } else {
    details.push('no duplicate memory names in project spaces');
  }

  let artifactOk = false;
  const artifactPath = join(ctx.workspaceDir, B10_ARTIFACT_FILE);
  if (!existsSync(artifactPath)) {
    details.push(`${B10_ARTIFACT_FILE} was not written`);
  } else {
    const artifact = readFileSync(artifactPath, 'utf8');
    const carriesFact = carriesTargetFact(artifact);
    const answersDistractor = carriesDistractorFact(artifact);
    artifactOk = carriesFact && !answersDistractor;
    if (!carriesFact) {
      details.push(
        `${B10_ARTIFACT_FILE} does not contain the target fact (${B10_ANSWER_TERMS.join(' ')})`
      );
    }
    if (answersDistractor) {
      details.push(`${B10_ARTIFACT_FILE} answers with the distractor fact`);
    }
    if (artifactOk) {
      details.push(`${B10_ARTIFACT_FILE} carries the paraphrase recall`);
    }
  }

  return {
    pass: Boolean(target) && targetOk && duplicates.length === 0 && artifactOk,
    details,
  };
}

export const B10_SCENARIO: Scenario = {
  id: 'b10',
  title: 'Semantic recall (paraphrase-only)',
  fixture: 'fixtures/b10',
  // Only a Mind condition with RAG can seed embeddings and recall by meaning.
  rag: true,
  requires: ['mind-memory', 'semantic-recall'],
  seed: seedB10,
  sessions: [{ prompt: B10_PROMPTS[0]! }],
  makeAssertion,
};
