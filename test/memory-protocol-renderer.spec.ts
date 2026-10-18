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
  test('renders durable memory and living reference guidance for agents', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('Durable memory threshold');
    expect(rendered).toContain('Living reference memories');
    expect(rendered).toContain('status:living');
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

  test('renders concise mind-only memory type decision guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

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

  test('renders compact link guidance with creation result checks', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain(
      'When a new memory depends on, updates, or explains another memory, pass related memories in `links_to`.'
    );
    expect(rendered).toContain(
      'After adding with `links_to`, check `links_created` and `links_failed`; retry important failed links with `link_create`.'
    );
    expect(rendered).not.toContain('memory is worse if not linked');
  });

  test('renders search grammar and confidence guidance', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain('### Searching effectively');
    expect(rendered).toContain('Query grammar:');
    expect(rendered).toContain('`OR` unions alternatives');
    expect(rendered).toContain('`NOT` excludes the following term');
    expect(rendered).toContain('A trailing `*` matches a prefix');
    expect(rendered).toContain('Read `confidence`');
    expect(rendered).toContain('When results are empty or mostly `low`');
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
