import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderMemoryProtocol } from '../src/cli/memory-protocol';

function readSnapshot(name: string): string {
  return readFileSync(join(import.meta.dir, 'snapshots', name), 'utf-8');
}

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

describe('memory protocol renderer', () => {
  test('renders the six responsibilities with trigger and example guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

    for (const responsibility of ['ORIENT', 'RECALL', 'LEARN', 'RELATE', 'MAINTAIN', 'HANDOFF']) {
      expect(rendered).toContain(`## ${responsibility}`);
    }
    expect(rendered).toContain('**Trigger:**');
    expect(rendered).toContain('```json tool:memory_add');
  });

  test('renders durable memory and living reference guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('Every memory needs at least one tag.');
    expect(rendered).toMatch(
      /Check for a related or equivalent memory before creating a new one when\s+duplication is reasonably possible\./
    );
    expect(rendered).toContain('type:reference');
    expect(rendered).toContain('status:living');
    expect(rendered).toContain('ref:key-decisions');
    expect(rendered).toContain('ref:known-pitfalls');
    expect(rendered).toContain('not on a calendar quota');
  });

  test('renders checkpoint events and required space parameters', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('A plan is approved, a subtask finishes, a decision or blocker');
    expect(rendered).toContain('checkpoint_query { space:');
    expect(rendered).toContain('checkpoint_load { space:');
    expect(rendered).not.toContain('less than 30 minutes old');
  });

  test('renders link meaning, direction, and relabel guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('depends_on');
    expect(rendered).toContain('caused_by');
    expect(rendered).toContain('contradicts');
    expect(rendered).toContain('Re-creating the same directed pair replaces');
    expect(rendered).toContain('`outgoing` or `incoming`');
    expect(rendered).toContain('succeeds as a no-op when it is absent');
  });

  test('renders tier, pin, and explicit transition semantics', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('T3 is not a ranking penalty');
    expect(rendered).toContain('explicit `tierTransition` still moves it');
    expect(rendered).toContain('noPromote: true');
    expect(rendered).toContain('`memory_query` does not record access');
    expect(rendered).not.toContain('Move old memories to T3');
  });

  test('renders search grammar and confidence guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('## RECALL');
    expect(rendered).toContain('quoted phrases');
    expect(rendered).toContain('`OR`');
    expect(rendered).toContain('`NOT`');
    expect(rendered).toContain('trailing `*`');
    expect(rendered).toContain('`confidence`');
    expect(rendered).toContain('`methods`');
    expect(rendered).toContain('RAG is optional and off by default');
  });

  test('rendered protocols avoid workflow-specific orchestration language', () => {
    const renderedProtocols = [
      renderMemoryProtocol('opencode'),
      renderMemoryProtocol('claude-code'),
      renderMemoryProtocol('codex'),
    ];

    for (const rendered of renderedProtocols) {
      for (const forbiddenTerm of PRODUCT_PROTOCOL_FORBIDDEN_TERMS) {
        expect(rendered).not.toContain(forbiddenTerm);
      }
    }
  });

  test('renders OpenCode protocol variant snapshot', () => {
    const rendered = renderMemoryProtocol('opencode');
    const snapshot = readSnapshot('memory-protocol.opencode.md');

    expect(rendered).toBe(snapshot);
  });

  test('renders Claude protocol variant snapshot', () => {
    const rendered = renderMemoryProtocol('claude-code');
    const snapshot = readSnapshot('memory-protocol.claude-code.md');

    expect(rendered).toBe(snapshot);
  });

  test('renders Codex protocol variant snapshot', () => {
    const rendered = renderMemoryProtocol('codex');
    const snapshot = readSnapshot('memory-protocol.codex.md');

    expect(rendered).toBe(snapshot);
  });
});
