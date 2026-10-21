import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { renderMemoryProtocol } from '../src/cli/memory-protocol';
import { renderMindManagementSkill } from '../src/cli/mind-management-skill';
import { renderSkillActivation, renderSkillLoadNote } from '../src/cli/skill-activation';
import { renderSystemInstructions } from '../src/cli/system-instructions';
import { renderTemplate } from '../src/helpers/template-renderer';
import { CheckpointDoneSchema } from '../src/mcp/schemas/checkpoint/done-checkpoint';
import { CheckpointLoadSchema } from '../src/mcp/schemas/checkpoint/load-checkpoint';
import { CheckpointQuerySchema } from '../src/mcp/schemas/checkpoint/query-checkpoints';
import { CheckpointSaveSchema } from '../src/mcp/schemas/checkpoint/save-checkpoint';
import { LinkCreateSchema } from '../src/mcp/schemas/links/create-link';
import { LinkDeleteSchema } from '../src/mcp/schemas/links/delete-link';
import { MemoryAddSchema } from '../src/mcp/schemas/memories/add-memory';
import { MemoryQuerySchema } from '../src/mcp/schemas/memories/query-memories';
import { MemoryReadSchema } from '../src/mcp/schemas/memories/read-memory';
import { MemoryUpdateSchema } from '../src/mcp/schemas/memories/update-memory';
import { SpaceGetSchema } from '../src/mcp/schemas/spaces/get-space';
import {
  ensureMindManagementSkill,
  getCanonicalSkillDir,
  SKILL_OWNERSHIP_MARKER,
} from '../src/setup/skill-installation';

const CANONICAL_BODY_PATH = join(
  import.meta.dir,
  '..',
  'src',
  'resources',
  'protocols',
  'mind-cognitive-protocol.md'
);

const BODY_MARKER = '<!-- mind-cognitive-protocol:body -->';
const KNOWN_LONG_PARAGRAPH =
  'Check for a related or equivalent memory before creating a new one when\nduplication is reasonably possible. Reuse or update the existing memory instead\nof adding a near-duplicate.';

const RESPONSIBILITIES = ['ORIENT', 'RECALL', 'LEARN', 'RELATE', 'MAINTAIN', 'HANDOFF'] as const;

const CRITICAL_TOOLS = [
  'memory_update',
  'memory_add',
  'memory_query',
  'memory_read',
  'link_create',
  'checkpoint_query',
  'checkpoint_load',
  'space_get',
] as const;

const TOOL_SCHEMAS: Record<string, unknown> = {
  memory_add: MemoryAddSchema,
  memory_update: MemoryUpdateSchema,
  memory_query: MemoryQuerySchema,
  memory_read: MemoryReadSchema,
  link_create: LinkCreateSchema,
  link_delete: LinkDeleteSchema,
  checkpoint_query: CheckpointQuerySchema,
  checkpoint_load: CheckpointLoadSchema,
  checkpoint_save: CheckpointSaveSchema,
  checkpoint_done: CheckpointDoneSchema,
  space_get: SpaceGetSchema,
};

function readCanonicalBody(): string {
  return readFileSync(CANONICAL_BODY_PATH, 'utf-8');
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function extractSkillDescription(skill: string): string {
  const frontmatterEnd = skill.indexOf('\n---', 3);
  const frontmatter = skill.slice(3, frontmatterEnd);
  const afterDescription = frontmatter.split('description: >')[1] ?? '';
  return afterDescription.split('\nlicense:')[0]?.replace(/\s+/g, ' ').trim() ?? '';
}

function sectionFor(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  if (start === -1) {
    return '';
  }
  const next = body.indexOf('\n## ', start + heading.length + 3);
  return next === -1 ? body.slice(start) : body.slice(start, next);
}

function fencedToolExamples(body: string): Array<{ tool: string; payload: unknown }> {
  const pattern = /```json tool:([a-z_]+)\n([\s\S]*?)```/g;
  return [...body.matchAll(pattern)].map(match => ({
    tool: match[1] as string,
    payload: JSON.parse(match[2] as string) as unknown,
  }));
}

function renderedOutputs(): Record<string, string> {
  return {
    'l2-opencode': renderMemoryProtocol('opencode'),
    'l2-claude-code': renderMemoryProtocol('claude-code'),
    'l2-codex': renderMemoryProtocol('codex'),
    'mcp-system-instructions': renderSystemInstructions(),
    skill: renderMindManagementSkill(),
  };
}

function completeOutputs(): Record<string, string> {
  return {
    'mcp-system-instructions': renderSystemInstructions(),
    skill: renderMindManagementSkill(),
  };
}

const L2_AGENTS = ['opencode', 'claude-code', 'codex'] as const;

describe('canonical cognitive protocol source', () => {
  test('canonical body is token-free and carries the body marker once', () => {
    const body = readCanonicalBody();

    expect(countOccurrences(body, BODY_MARKER)).toBe(1);
    expect(body).not.toContain('{{');
    expect(body).not.toContain('}}');
  });

  test('the skill and fallback embed the canonical body exactly once', () => {
    const body = readCanonicalBody();

    for (const [name, output] of Object.entries(completeOutputs())) {
      expect({ name, bodyOccurrences: countOccurrences(output, body) }).toEqual({
        name,
        bodyOccurrences: 1,
      });
      expect({ name, markerOccurrences: countOccurrences(output, BODY_MARKER) }).toEqual({
        name,
        markerOccurrences: 1,
      });
    }
  });

  test('L2 instructions are a brief activation without the canonical body', () => {
    const body = readCanonicalBody();

    for (const agent of L2_AGENTS) {
      const output = renderMemoryProtocol(agent);

      expect({ agent, bodyOccurrences: countOccurrences(output, body) }).toEqual({
        agent,
        bodyOccurrences: 0,
      });
      expect({ agent, markerOccurrences: countOccurrences(output, BODY_MARKER) }).toEqual({
        agent,
        markerOccurrences: 0,
      });
      expect(output).not.toContain('## ORIENT');
      expect(output).not.toContain('**Trigger:**');
      expect(output).not.toContain('```json tool:');
    }
  });

  test('L2 instructions name the skill as the source of truth and the fallback', () => {
    for (const agent of L2_AGENTS) {
      const output = renderMemoryProtocol(agent);

      expect(output).toContain(renderSkillActivation());
      expect(output).toContain('mind-management');
      expect(output).toContain('system_instructions');
      expect(output).toContain(
        'The source of truth is the `mind-management` skill, not this file.'
      );
      expect(output).toContain('unconditionally');
    }
  });

  test('the skill preserves YAML frontmatter and the skill load note', () => {
    const skill = renderMindManagementSkill();

    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: mind-management');
    expect(skill).toContain('license: MIT');
    expect(skill).toContain(renderSkillLoadNote());
    expect(skill.indexOf(renderSkillLoadNote())).toBeLessThan(skill.indexOf(BODY_MARKER));
  });

  test('the skill description carries the source-of-truth contract and pointer boundary', () => {
    const description = extractSkillDescription(renderMindManagementSkill());

    expect(description).toContain("Mind's single source of truth");
    expect(description).toContain('load this skill unconditionally');
    expect(description).toContain('before any Mind use');
    expect(description).toContain('Do not call a Mind MCP tool until');
    expect(description).toContain('only a pointer');
    expect(description).toContain('does not replace this skill');
    expect(description).toContain('not listed or cannot be loaded');
    expect(description).not.toContain('space_get');
  });

  test('the skill load note repeats the source-of-truth contract and fallback', () => {
    const loadNote = renderSkillLoadNote();

    expect(loadNote).toContain('single source of truth');
    expect(loadNote).toContain('unconditionally');
    expect(loadNote).toContain('before any Mind use');
    expect(loadNote).toContain('after compaction');
    expect(loadNote).toContain('not listed or cannot be loaded');
    expect(loadNote).toContain('`system_instructions`');
    expect(loadNote).toContain('pointers only');
  });

  test('no normative paragraph is duplicated within the complete outputs', () => {
    for (const [name, output] of Object.entries(completeOutputs())) {
      expect({
        name,
        paragraphOccurrences: countOccurrences(output, KNOWN_LONG_PARAGRAPH),
      }).toEqual({ name, paragraphOccurrences: 1 });
    }
  });

  test('rendered outputs contain no unresolved template tokens', () => {
    for (const output of Object.values(renderedOutputs())) {
      expect(output).not.toMatch(/\{\{[^}]*\}\}/);
    }
  });

  test('the canonical body has exactly one section per responsibility', () => {
    const body = readCanonicalBody();

    for (const responsibility of RESPONSIBILITIES) {
      expect(countOccurrences(body, `## ${responsibility}`)).toBe(1);
    }
  });

  test('each responsibility section has a trigger and a concrete tool example', () => {
    const body = readCanonicalBody();

    for (const responsibility of RESPONSIBILITIES) {
      const section = sectionFor(body, responsibility);
      expect({ responsibility, hasTrigger: section.includes('**Trigger:**') }).toEqual({
        responsibility,
        hasTrigger: true,
      });
      expect({ responsibility, hasToolExample: /```json tool:[a-z_]+/.test(section) }).toEqual({
        responsibility,
        hasToolExample: true,
      });
    }
  });

  test('the canonical body avoids mandatory and stale framing', () => {
    const body = readCanonicalBody();

    for (const forbidden of [
      'Must be called before',
      'MANDATORY',
      'no exceptions',
      'Move old memories to T3',
      'mind_system_instructions',
      'hot preview',
      'Required First Actions',
    ]) {
      expect({ forbidden, occurrences: countOccurrences(body, forbidden) }).toEqual({
        forbidden,
        occurrences: 0,
      });
    }
  });

  test('the canonical body keeps the required normative fragments', () => {
    const body = readCanonicalBody();

    for (const fragment of [
      'checkpoint_query { space:',
      'checkpoint_load { space:',
      '"pinned": true',
      '"tierTransition": "promote"',
      '"label": "implements"',
      'noPromote: true',
      'status:superseded',
      'type:reference',
      'ref:known-pitfalls',
    ]) {
      expect({ fragment, present: body.includes(fragment) }).toEqual({
        fragment,
        present: true,
      });
    }
  });

  test('superseded memory_update examples preserve the historical content', () => {
    const examples = fencedToolExamples(readCanonicalBody());
    const supersededUpdates = examples.filter(example => {
      if (example.tool !== 'memory_update') {
        return false;
      }
      const tags = (example.payload as { tags?: unknown }).tags;
      return Array.isArray(tags) && tags.includes('status:superseded');
    });

    expect(supersededUpdates.length).toBeGreaterThan(0);

    for (const example of supersededUpdates) {
      expect({
        payload: example.payload,
        hasContent: Object.prototype.hasOwnProperty.call(example.payload, 'content'),
      }).toEqual({ payload: example.payload, hasContent: false });
    }
  });

  test('the protocol teaches natural-first recall and explicit linking semantics', () => {
    const body = readCanonicalBody();

    for (const fragment of [
      'Why did we choose JWT for authentication?',
      'One query is usually enough',
      '`memory_add.links_to` creates a generic `related` link',
      '`link_create` when the relation has a',
      '`memory_update.tags` replaces the whole set',
    ]) {
      expect({ fragment, present: body.includes(fragment) }).toEqual({
        fragment,
        present: true,
      });
    }
  });

  test('every fenced tool example validates against its real schema', () => {
    const examples = fencedToolExamples(readCanonicalBody());

    for (const tool of CRITICAL_TOOLS) {
      expect({ tool, present: examples.some(example => example.tool === tool) }).toEqual({
        tool,
        present: true,
      });
    }

    for (const example of examples) {
      const schema = TOOL_SCHEMAS[example.tool];
      expect({ tool: example.tool, hasSchema: Boolean(schema) }).toEqual({
        tool: example.tool,
        hasSchema: true,
      });

      const result = (schema as any).strict().safeParse(example.payload);
      expect({
        tool: example.tool,
        success: result.success,
        issues: result.success ? [] : result.error.issues,
      }).toEqual({ tool: example.tool, success: true, issues: [] });
    }
  });

  test('a missing protocolBody placeholder key still fails the strict renderer', () => {
    expect(() => renderTemplate('{{protocolBody}}', {})).toThrow(/protocolBody/);
    expect(() => renderTemplate('{{#if protocolBody}}body{{/if}}', {})).toThrow(/protocolBody/);
  });
});

describe('mind-management skill installation', () => {
  let previousHome = '';
  let tempHome = '';

  beforeEach(() => {
    previousHome = process.env.HOME ?? '';
    tempHome = mkdtempSync(join(tmpdir(), 'mind-skill-install-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    if (tempHome && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('installs the rendered skill once at the canonical path for OpenCode', () => {
    const installedPath = ensureMindManagementSkill('opencode');

    expect(installedPath).not.toBeNull();
    expect(installedPath as string).toBe(join(getCanonicalSkillDir(), 'SKILL.md'));
    expect(
      existsSync(join(tempHome, '.config', 'opencode', 'skills', 'mind-management', 'SKILL.md'))
    ).toBe(false);

    const content = readFileSync(installedPath as string, 'utf-8');
    expect(content).toBe(renderMindManagementSkill());
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: mind-management');
    expect(content).toContain('license: MIT');
    expect(content).toContain(SKILL_OWNERSHIP_MARKER);
    expect(content).toContain(BODY_MARKER);
  });

  test('installs the rendered skill for the shared ~/.agents directory', () => {
    const installedPath = ensureMindManagementSkill('codex');

    expect(installedPath).not.toBeNull();
    expect(installedPath as string).toBe(join(getCanonicalSkillDir(), 'SKILL.md'));
    expect(installedPath as string).toContain(
      join('.agents', 'skills', 'mind-management', 'SKILL.md')
    );
    const content = readFileSync(installedPath as string, 'utf-8');
    expect(content).toBe(renderMindManagementSkill());
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: mind-management');
    expect(content).toContain(SKILL_OWNERSHIP_MARKER);
    expect(content).toContain(BODY_MARKER);
  });
});
