import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderSystemInstructions } from '../src/cli/system-instructions';
import { createSystemTools } from '../src/mcp/tools/system';

const SYSTEM_INSTRUCTIONS_SOURCE_PATH = join(
  import.meta.dir,
  '..',
  'src',
  'resources',
  'protocols',
  'mind-system-instructions.md'
);

const SYSTEM_INSTRUCTIONS_SNAPSHOT_PATH = join(
  import.meta.dir,
  'snapshots',
  'system-instructions.md'
);

const PRODUCT_PROTOCOL_FORBIDDEN_TERMS = [
  'QA PASS',
  'routine PASS',
  'Subagent Memory Writes',
  'Subagent memory writes',
  'memory_writes',
  'not_persisted',
  'Nova',
  'NAS',
];

describe('MCP System Tools', () => {
  test('system instructions renderer should match snapshot', () => {
    const snapshotText = readFileSync(SYSTEM_INSTRUCTIONS_SNAPSHOT_PATH, 'utf-8');

    expect(renderSystemInstructions()).toBe(snapshotText);
    expect(renderSystemInstructions()).toBe(snapshotText);
  });

  test('system instructions renderer should be deterministic and equal to canonical source text', () => {
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');

    expect(renderSystemInstructions()).toBe(sourceText);
    expect(renderSystemInstructions()).toBe(sourceText);
  });

  test('system instructions describe memory quality tiers and living references', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('Durable memory threshold');
    expect(rendered).toContain('Checkpoint = live/ephemeral work state');
    expect(rendered).toContain('type:reference');
    expect(rendered).toContain(
      'Required tags: `type:reference`, exactly one `ref:*`, and `status:living`.'
    );
    expect(rendered).toContain(
      'The `ref:*` tag defines the reference category; the memory name is the readable identifier.'
    );
    expect(rendered).toContain(
      'Recommended names: `architecture-overview`, `project-map`, `style-guide`, `domain-model`, and `workflow-notes`.'
    );
    expect(rendered).not.toContain('Recommended names: `ref-project-map`');
    expect(rendered).toContain('status:superseded');
    expect(rendered).toMatch(/routine\s+validation results with no new findings/);
    expect(rendered).toMatch(
      /verified root causes, regressions, risk decisions, or durable validation\s+patterns/
    );
    expect(rendered).toContain('Before creating a durable memory');
    expect(rendered).toContain('Future utility');
    expect(rendered).toContain('Evidence');
    expect(rendered).toContain('Stability');
    expect(rendered).toContain('Living reference taxonomy and maintenance');
    expect(rendered).toContain('ref:key-decisions');
    expect(rendered).toContain('ref:known-pitfalls');
    expect(rendered).toContain('30 days');
    expect(rendered).toContain('project-map');
  });

  test('system instructions describe session summary flow and decision matrix', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toMatch(/\| Need\s+\| Use\s+\| Result\s+\|/);
    expect(rendered).toMatch(
      /\| Live goal, pending work, blockers, or next action\s+\| `checkpoint_save`\s+\| Active checkpoint\s+\|/
    );
    expect(rendered).toMatch(
      /\| Stable decisions, root causes, patterns, preferences, config, or domain facts\s+\| `memory_add` \/ `memory_update`\s+\| Durable memory\s+\|/
    );
    expect(rendered).toContain(
      'Checkpoints hold live state; `checkpoint_done` completes the active checkpoint'
    );
    expect(rendered).toContain('Durable memories are separate from session summaries.');
    expect(rendered).not.toContain('do not create session summaries manually');
  });

  test('system instructions describe compact linking guidance', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain(
      'When a new memory depends on, updates, or explains another memory, pass related memories in `links_to`.'
    );
    expect(rendered).toContain(
      'After adding with `links_to`, check `links_created` and `links_failed`; retry important failed links with `link_create`.'
    );
    expect(rendered).not.toContain('memory is worse if not linked');
  });

  test('system instructions describe search grammar and confidence guidance', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('## Searching Effectively');
    expect(rendered).toContain('Query grammar:');
    expect(rendered).toContain('`OR` unions alternatives');
    expect(rendered).toContain('`NOT` excludes the following term');
    expect(rendered).toContain('A trailing `*` matches a prefix');
    expect(rendered).toContain('Read `confidence`');
    expect(rendered).toContain('When results are empty or mostly `low`');
  });

  test('system instructions avoid workflow-specific orchestration language', () => {
    const rendered = renderSystemInstructions();

    for (const forbiddenTerm of PRODUCT_PROTOCOL_FORBIDDEN_TERMS) {
      expect(rendered).not.toContain(forbiddenTerm);
    }
  });

  test('system instructions close example uses checkpoint_done for session summaries', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('// 6. Session end: close the checkpoint');
    expect(rendered).toContain('checkpoint_done {');
    expect(rendered).not.toContain('// 6. Session end: summarize\nmemory_add {');
  });

  test('system_instructions MCP contract should remain stable', async () => {
    const tools = createSystemTools();

    expect(Object.keys(tools)).toEqual(['system_instructions']);

    const tool = tools.system_instructions;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ anything: 'else' }).success).toBe(true);

    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await tool.handler();
    expect(response).toEqual({
      content: [{ type: 'text', text: renderSystemInstructions() }],
      instructions_version: '1.4.0',
    });
  });

  test('system_instructions should load protocol text from markdown source file', async () => {
    const tools = createSystemTools();
    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await tools.system_instructions.handler();
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');

    expect(response.instructions_version).toBe('1.4.0');
    expect(response.content[0]?.type).toBe('text');
    expect(response.content[0]?.text).toBe(sourceText);
  });
});
