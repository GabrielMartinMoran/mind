// Scenario B6 — relinking.
//
// The unit starts with two seeded memories (a strategy and its implementation)
// connected by a stale `related` link. Session 1 asks the agent
// to correct the relationship now that the implementation realizes the
// strategy. Session 2 asks it to use the stored relation and write the answer
// to a workspace file.
//
// Design note: seeding goes through the isolated `mind` CLI/env (never direct
// SQL, never the live database). The assertion reads the stored link direction
// and label plus the workspace answer artifact — never the agent's prose.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectAllLinks } from '../../../mind/inspect';
import type {
  Scenario,
  ScenarioAssertionContext,
  ScenarioAssertionResult,
  ScenarioSeedContext,
} from '../../scenario';

// Flat space name: the CLI `link` reference grammar is `space/name`, so a
// nested `projects/...` space cannot be addressed by the isolated seed CLI.
export const B6_SPACE = 'b6-app';
export const B6_STRATEGY = 'checkout-strategy';
export const B6_IMPLEMENTATION = 'checkout-implementation';
export const B6_STALE_LABEL = 'related';
export const B6_INTENDED_LABEL = 'implements';
export const B6_ANSWER_FILE = 'answer.txt';

export const B6_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    'The checkout implementation in `src/checkout.ts` now realizes the checkout strategy. The stored relationship between the project memories `checkout-strategy` and `checkout-implementation` is out of date.',
    '',
    'Correct the stored relationship so that the implementation realizes the strategy: the link must point from `checkout-implementation` to `checkout-strategy` with the label `implements`, and the old `related` label must be gone.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    'Using the stored relationship between `checkout-implementation` and `checkout-strategy`, answer this question: which memory does `checkout-implementation` realize?',
    '',
    `Write only the name of that memory to \`${B6_ANSWER_FILE}\` in the current directory.`,
  ].join('\n'),
];

/** Seed the two memories and the stale link through the isolated CLI. */
export async function seedB6(ctx: ScenarioSeedContext): Promise<void> {
  if (!ctx.mindBin || !ctx.mindDb) return;

  // Merge the host env for PATH/interpreter lookup; the isolated MIND_* pointers
  // and HOME/XDG overrides in `ctx.env` always win, so the live DB is never used.
  const env: Record<string, string | undefined> = { ...process.env, ...ctx.env };
  const run = (args: readonly string[]) => ctx.run({ command: ctx.mindBin!, args, env });

  const mustRun = async (args: readonly string[]): Promise<void> => {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(`B6 seed failed (mind ${args.join(' ')}): ${result.stderr.trim()}`);
    }
  };

  await mustRun(['create', B6_SPACE, 'Checkout benchmark fixture project']);
  await mustRun([
    'add',
    B6_SPACE,
    B6_STRATEGY,
    'Checkout uses a two-step authorize-then-capture flow.',
  ]);
  await mustRun([
    'add',
    B6_SPACE,
    B6_IMPLEMENTATION,
    'The checkout implementation lives in src/checkout.ts.',
  ]);
  await mustRun([
    'link',
    `${B6_SPACE}/${B6_IMPLEMENTATION}`,
    `${B6_SPACE}/${B6_STRATEGY}`,
    '--label',
    B6_STALE_LABEL,
  ]);
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];

  if (!ctx.mindDb || !existsSync(ctx.mindDb)) {
    return { pass: false, details: ['no Mind database available for this unit'] };
  }

  const links = inspectAllLinks(ctx.mindDb);

  const intended = links.find(
    link =>
      link.source === B6_IMPLEMENTATION &&
      link.target === B6_STRATEGY &&
      link.label === B6_INTENDED_LABEL
  );
  const stale = links.find(
    link =>
      link.source === B6_IMPLEMENTATION &&
      link.target === B6_STRATEGY &&
      link.label === B6_STALE_LABEL
  );
  const reversed = links.find(
    link =>
      link.source === B6_STRATEGY &&
      link.target === B6_IMPLEMENTATION &&
      link.label === B6_INTENDED_LABEL
  );

  if (intended) {
    details.push(
      `expected link stored: ${B6_IMPLEMENTATION} → ${B6_STRATEGY} [${B6_INTENDED_LABEL}]`
    );
  } else if (reversed) {
    details.push(`wrong direction: ${B6_STRATEGY} → ${B6_IMPLEMENTATION} [${B6_INTENDED_LABEL}]`);
  } else {
    details.push(
      `expected link missing: ${B6_IMPLEMENTATION} → ${B6_STRATEGY} [${B6_INTENDED_LABEL}]`
    );
  }

  if (stale) {
    details.push(
      `old label still present: ${B6_IMPLEMENTATION} → ${B6_STRATEGY} [${B6_STALE_LABEL}]`
    );
  } else {
    details.push('old related label is gone');
  }

  let answerOk = false;
  const answerPath = join(ctx.workspaceDir, B6_ANSWER_FILE);
  if (!existsSync(answerPath)) {
    details.push(`${B6_ANSWER_FILE} was not written`);
  } else {
    const answer = readFileSync(answerPath, 'utf8').toLowerCase();
    answerOk = answer.includes(B6_STRATEGY);
    details.push(
      answerOk
        ? `${B6_ANSWER_FILE} names the related memory`
        : `${B6_ANSWER_FILE} does not name ${B6_STRATEGY}`
    );
  }

  return { pass: Boolean(intended) && !stale && answerOk, details };
}

export const B6_SCENARIO: Scenario = {
  id: 'b6',
  title: 'Relinking',
  fixture: 'fixtures/b6',
  // DB/link assertions need a Mind engine. B7/B9 will declare the same requirement.
  requires: ['mind-memory'],
  seed: seedB6,
  sessions: [{ prompt: B6_PROMPTS[0]! }, { prompt: B6_PROMPTS[1]! }],
  makeAssertion,
};
