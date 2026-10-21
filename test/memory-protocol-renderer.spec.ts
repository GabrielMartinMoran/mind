import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderMemoryProtocol } from '../src/cli/memory-protocol';
import { renderSkillActivation } from '../src/cli/skill-activation';

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

const RESPONSIBILITY_HEADINGS = ['ORIENT', 'RECALL', 'LEARN', 'RELATE', 'MAINTAIN', 'HANDOFF'];

const AGENTS = [
  { agent: 'opencode', label: 'mind' },
  { agent: 'claude-code', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
] as const;

describe('memory protocol renderer', () => {
  test('renders a brief activation that names the skill and the fallback', () => {
    const rendered = renderMemoryProtocol('opencode');

    expect(rendered).toContain(renderSkillActivation());
    expect(rendered).toContain('mind-management');
    expect(rendered).toContain('system_instructions');
    expect(rendered).toContain('source of truth');
    expect(rendered).toContain('unconditionally');
    expect(rendered).toContain('session start');
    expect(rendered).toContain('compaction');
    expect(rendered).toContain(
      'The source of truth is the `mind-management` skill, not this file.'
    );
  });

  test('the activation is a pointer rather than over-emphasized protocol text', () => {
    const rendered = renderMemoryProtocol('opencode');

    for (const emphasis of ['MANDATORY', 'CRITICAL', 'no exceptions']) {
      expect({ emphasis, present: rendered.includes(emphasis) }).toEqual({
        emphasis,
        present: false,
      });
    }
  });

  test('L2 output does not contain the canonical protocol body', () => {
    for (const { agent } of AGENTS) {
      const rendered = renderMemoryProtocol(agent);

      expect(rendered).not.toContain('<!-- mind-cognitive-protocol:body -->');
      expect(rendered).not.toContain('**Trigger:**');
      expect(rendered).not.toContain('```json tool:');
      for (const responsibility of RESPONSIBILITY_HEADINGS) {
        expect(rendered).not.toContain(`## ${responsibility}`);
      }
    }
  });

  test('renders the agent-specific title label', () => {
    for (const { agent, label } of AGENTS) {
      expect(renderMemoryProtocol(agent)).toContain(`# Mind activation pointer (${label})`);
    }
  });

  test('rendered protocols avoid workflow-specific orchestration language', () => {
    for (const { agent } of AGENTS) {
      const rendered = renderMemoryProtocol(agent);
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
