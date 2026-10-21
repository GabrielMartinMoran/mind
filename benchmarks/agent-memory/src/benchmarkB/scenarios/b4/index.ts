// Scenario B4 — transfer to a sub-agent.
//
// Session 1 runs the project's tests, investigates the failing test and REPORTS
// the root cause + fix strategy (no repository changes). Session 2 explicitly
// instructs the agent to DELEGATE the fix implementation to a sub-agent, so the
// run yields a child session linked to the parent.
//
// Design note: the assertion checks the fix landed (the test suite passes) and
// that a child session was created. Whether the child used memory tools is
// measured and reported, but NOT required for the scenario to pass.

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Scenario, ScenarioAssertionContext, ScenarioAssertionResult } from '../../scenario';

/**
 * The fixture ships the intentionally-failing test under a NON-`*.test.*` name
 * so a bare `bun test` at the repository root never discovers it. The scenario
 * renames it into `range.test.ts` inside the isolated workspace, so the failing
 * assertion still runs there (and can be fixed there) during the scenario.
 */
export const B4_FIXTURE_TEST_FILE = 'src/range.b4fixture.ts';
export const B4_WORKSPACE_TEST_FILE = 'src/range.test.ts';

export const B4_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    "Run the project's test suite and investigate the failing test. Determine the root cause of the bug and the correct fix strategy.",
    '',
    'Do NOT modify any repository file in this session. Report the root cause and the fix strategy, and preserve your findings so that a future session can apply the fix without investigating again.',
  ].join('\n'),
  [
    'A previous session investigated a bug in this project.',
    '',
    'Delegate the implementation of the fix to a sub-agent: spawn a sub-agent and instruct it to fix the bug where the range check incorrectly rejects values that lie exactly on the minimum or maximum bound.',
    '',
    "The sub-agent must modify the repository as needed and make the project's test suite pass.",
  ].join('\n'),
];

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];
  let pass = true;

  // 1. The bug is fixed: the test suite passes.
  const result = await ctx.run({ command: 'bun', args: ['test'] });
  if (result.exitCode !== 0) {
    pass = false;
    const output = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    details.push(`test suite failed (exit ${result.exitCode}): ${output}`);
  } else {
    details.push('test suite passed');
  }

  // 2. The work was delegated: at least one child session exists.
  if (ctx.childResults.length === 0) {
    pass = false;
    details.push('no child (sub-agent) session was created');
  } else {
    details.push(`${ctx.childResults.length} child session(s) captured`);
  }

  // Measured, not required: did any child use memory tools?
  const childUsedMemory = ctx.childResults.some(child => child.memoryCalls > 0);
  details.push(`child used memory tools: ${childUsedMemory ? 'yes' : 'no'}`);

  return { pass, details };
}

export const B4_SCENARIO: Scenario = {
  id: 'b4',
  title: 'Sub-agent transfer',
  fixture: 'fixtures/b4',
  prepare: ({ workspaceDir }) => {
    const source = join(workspaceDir, B4_FIXTURE_TEST_FILE);
    // Guarded so an injected (fake) copyDir without real fixture files is a no-op.
    if (existsSync(source)) renameSync(source, join(workspaceDir, B4_WORKSPACE_TEST_FILE));
  },
  sessions: [{ prompt: B4_PROMPTS[0]! }, { prompt: B4_PROMPTS[1]! }],
  makeAssertion,
};
