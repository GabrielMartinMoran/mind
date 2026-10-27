import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { loadCanonicalProtocolBody } from '../src/cli/memory-protocol';
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
  test('system instructions are the labeled fallback used when the skill is unavailable', async () => {
    const rendered = renderSystemInstructions();

    expect(rendered.startsWith('# Mind Memory Protocol (fallback)')).toBe(true);
    expect(rendered).toContain('complete fallback copy for the `mind` MCP server');
    expect(rendered).toContain(
      'used only when the `mind-management` skill is not listed or cannot be loaded'
    );
    expect(rendered).toContain('The skill is the primary source of truth');
    expect(rendered).toContain('load it unconditionally before any Mind use');
    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await createSystemTools().system_instructions.handler();
    expect(response.instructions_version).toBe('2.3.0');
  });

  test('system instructions describe operator casing, omit-vs-search, and validation recovery', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('Only uppercase `AND`, `OR`, and `NOT` are boolean operators');
    expect(rendered).toContain('Omit `search` to list memories by metadata');
    expect(rendered).toContain('add a specific topic');
  });

  test('system instructions renderer should match snapshot', () => {
    const snapshotText = readFileSync(SYSTEM_INSTRUCTIONS_SNAPSHOT_PATH, 'utf-8');

    expect(renderSystemInstructions()).toBe(snapshotText);
    expect(renderSystemInstructions()).toBe(snapshotText);
  });

  test('system instructions renderer should be deterministic and equal to the composed canonical source', () => {
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');
    const expected = `${sourceText.replace('{{protocolBody}}', loadCanonicalProtocolBody()).trimEnd()}\n`;

    expect(expected).toContain(loadCanonicalProtocolBody());
    expect(renderSystemInstructions()).toBe(expected);
    expect(renderSystemInstructions()).toBe(expected);
  });

  test('system instructions describe memory quality and living references', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('Every memory needs at least one tag.');
    expect(rendered).toContain('type:reference');
    expect(rendered).toContain('exactly one `ref:*` tag');
    expect(rendered).toContain('status:living');
    expect(rendered).toContain('ref:key-decisions');
    expect(rendered).toContain('ref:known-pitfalls');
    expect(rendered).toContain('status:superseded');
    expect(rendered).toContain('not on a calendar quota');
    expect(rendered).toContain('Link source memories');
  });

  test('system instructions describe checkpoint events and session handoff', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('A plan is approved, a subtask finishes, a decision or blocker');
    expect(rendered).toContain('Save a checkpoint at those events.');
    expect(rendered).toContain('checkpoint_query { space:');
    expect(rendered).toContain('checkpoint_load { space:');
    expect(rendered).toContain('`checkpoint_done` to turn the active checkpoint into a');
    expect(rendered).not.toContain('less than 30 minutes old');
  });

  test('system instructions describe compact linking guidance', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('`depends_on`');
    expect(rendered).toContain('`caused_by`');
    expect(rendered).toContain('`contradicts`');
    expect(rendered).toContain('Re-creating the same directed pair replaces');
    expect(rendered).toContain('succeeds as a no-op when it is absent');
  });

  test('system instructions describe search grammar and confidence guidance', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('`memory_query` supports quoted phrases');
    expect(rendered).toContain('`OR`');
    expect(rendered).toContain('`NOT`');
    expect(rendered).toContain('trailing `*`');
    expect(rendered).toContain('`confidence`');
    expect(rendered).toContain('`methods`');
    expect(rendered).toContain('RAG is optional and off by default');
  });

  test('system instructions avoid workflow-specific orchestration language', () => {
    const rendered = renderSystemInstructions();

    for (const forbiddenTerm of PRODUCT_PROTOCOL_FORBIDDEN_TERMS) {
      expect(rendered).not.toContain(forbiddenTerm);
    }
  });

  test('system instructions close example uses checkpoint_done for session summaries', () => {
    const rendered = renderSystemInstructions();

    expect(rendered).toContain('```json tool:checkpoint_done');
    expect(rendered).toContain('turn the active checkpoint into a');
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
      instructions_version: '2.3.0',
    });
  });

  test('system_instructions should compose the protocol text from the canonical body', async () => {
    const tools = createSystemTools();
    // @ts-ignore — handler accepts 0 args but type system requires 1
    const response = await tools.system_instructions.handler();
    const sourceText = readFileSync(SYSTEM_INSTRUCTIONS_SOURCE_PATH, 'utf-8');
    const expected = `${sourceText.replace('{{protocolBody}}', loadCanonicalProtocolBody()).trimEnd()}\n`;

    expect(response.instructions_version).toBe('2.3.0');
    expect(response.content[0]?.type).toBe('text');
    expect(response.content[0]?.text).toBe(expected);
  });
});
