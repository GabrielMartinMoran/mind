import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { renderMindManagementSkill } from '../src/cli/mind-management-skill';
import {
  type AgentSkillType,
  ensureCanonicalSkill,
  getAgentSkillLayout,
  getAgentSkillPath,
  getAgentSkillSignalPaths,
  getCanonicalSkillDir,
  installMindManagementSkill,
  isManagedSkillContent,
  SKILL_OWNERSHIP_MARKER,
} from '../src/setup/skill-installation';

const ALL_AGENTS: AgentSkillType[] = [
  'opencode',
  'claude-code',
  'cursor',
  'codex',
  'gemini-cli',
  'vscode',
  'windsurf',
  'antigravity',
  'pi',
];

let previousHome = '';
let tempHome = '';

beforeEach(() => {
  previousHome = process.env.HOME ?? '';
  tempHome = mkdtempSync(join(tmpdir(), 'mind-skill-installation-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = previousHome;
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function canonicalFile(): string {
  return join(getCanonicalSkillDir(), 'SKILL.md');
}

function oldMindSkillContent(): string {
  return [
    '---',
    'name: mind-management',
    'description: Old mandatory Mind Management Protocol',
    '---',
    '',
    '# Mind Management Protocol',
    '',
    'MANDATORY: read this skill before every task.',
    '',
  ].join('\n');
}

function foreignSkillContent(): string {
  return [
    '---',
    'name: mind-management',
    'description: A user-owned custom skill',
    '---',
    '',
    '# My custom skill',
    '',
  ].join('\n');
}

function backupDirsFor(dirPath: string): string[] {
  const parent = dirname(dirPath);
  const prefix = `${dirPath.split('/').pop()}.bak.`;
  return readdirSync(parent).filter(name => name.startsWith(prefix));
}

describe('canonical skill installation', () => {
  test('creates the canonical skill with the ownership marker after the frontmatter', () => {
    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(result.warnings).toEqual([]);
    expect(existsSync(canonicalFile())).toBe(true);

    const content = readFileSync(canonicalFile(), 'utf-8');
    expect(content).toBe(renderMindManagementSkill());
    expect(content.split('\n')[0]).toBe('---');
    expect(content.split(SKILL_OWNERSHIP_MARKER)).toHaveLength(2);
    expect(content.indexOf(SKILL_OWNERSHIP_MARKER)).toBeGreaterThan(content.indexOf('\n---\n'));
  });

  test('is idempotent and creates no backup when the canonical bytes are unchanged', () => {
    ensureCanonicalSkill();
    const before = readFileSync(canonicalFile(), 'utf-8');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(before);
    expect(readdirSync(getCanonicalSkillDir()).filter(n => n.startsWith('SKILL.md.bak.'))).toEqual(
      []
    );
  });

  test('backs up and migrates an old Mind-managed canonical skill', () => {
    mkdirSync(getCanonicalSkillDir(), { recursive: true });
    writeFileSync(canonicalFile(), oldMindSkillContent());

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());

    const backups = readdirSync(getCanonicalSkillDir()).filter(n => n.startsWith('SKILL.md.bak.'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(getCanonicalSkillDir(), backups[0] as string), 'utf-8')).toBe(
      oldMindSkillContent()
    );

    ensureCanonicalSkill();
    expect(
      readdirSync(getCanonicalSkillDir()).filter(n => n.startsWith('SKILL.md.bak.'))
    ).toHaveLength(1);
  });

  test('never overwrites a foreign canonical skill and reports a warning', () => {
    mkdirSync(getCanonicalSkillDir(), { recursive: true });
    writeFileSync(canonicalFile(), foreignSkillContent());

    const result = ensureCanonicalSkill();

    expect(result.path).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('foreign');
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(foreignSkillContent());

    const installation = installMindManagementSkill('opencode');
    expect(installation.path).toBeNull();
    expect(installation.warnings).toHaveLength(1);
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(foreignSkillContent());
  });

  test('recognizes the ownership marker and the old Mind signature only', () => {
    expect(isManagedSkillContent(renderMindManagementSkill())).toBe(true);
    expect(isManagedSkillContent(oldMindSkillContent())).toBe(true);
    expect(isManagedSkillContent(foreignSkillContent())).toBe(false);
  });
});

describe('agent skill destinations', () => {
  test('installs every existing agent destination from the canonical skill', () => {
    for (const agent of ALL_AGENTS) {
      const result = installMindManagementSkill(agent);

      expect({ agent, path: result.path }).toEqual({ agent, path: getAgentSkillPath(agent) });
      expect({ agent, exists: existsSync(getAgentSkillPath(agent)) }).toEqual({
        agent,
        exists: true,
      });
      expect({ agent, content: readFileSync(getAgentSkillPath(agent), 'utf-8') }).toEqual({
        agent,
        content: renderMindManagementSkill(),
      });
      expect({ agent, canonical: existsSync(canonicalFile()) }).toEqual({
        agent,
        canonical: true,
      });
    }
  });

  test('Claude Code and Antigravity point at the canonical directory with symlinks', () => {
    for (const agent of ['claude-code', 'antigravity'] as const) {
      const result = installMindManagementSkill(agent);
      const targetDir = getAgentSkillLayout(agent).targetDir;

      expect(result.warnings).toEqual([]);
      expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
      expect(realpathSync(targetDir)).toBe(realpathSync(getCanonicalSkillDir()));
      expect(readFileSync(getAgentSkillPath(agent), 'utf-8')).toBe(renderMindManagementSkill());
    }
  });

  test('exposes canonical and dedicated signal paths from the single path helper', () => {
    expect(getAgentSkillSignalPaths('claude-code')).toContain(canonicalFile());
    expect(getAgentSkillSignalPaths('claude-code')).toContain(getAgentSkillPath('claude-code'));
    expect(getAgentSkillSignalPaths('opencode')).toContain(
      join(tempHome, '.config', 'opencode', 'skills', 'mind-management', 'SKILL.md')
    );
    expect(getAgentSkillSignalPaths('gemini-cli')).toContain(
      join(tempHome, '.gemini', 'skills', 'mind-management', 'SKILL.md')
    );
    expect(getAgentSkillSignalPaths('antigravity')).toContain(
      join(tempHome, '.gemini', 'antigravity', 'skills', 'mind-management', 'SKILL.md')
    );
    expect(getAgentSkillSignalPaths('pi')).toContain(canonicalFile());
    expect(getAgentSkillSignalPaths('pi')).toContain(
      join(tempHome, '.pi', 'agent', 'skills', 'mind-management', 'SKILL.md')
    );
  });
});

describe('shadow migration', () => {
  test('migrates managed OpenCode, Cursor, and Gemini shadows and preserves extras', () => {
    const cases: Array<[AgentSkillType, string]> = [
      ['opencode', join(tempHome, '.config', 'opencode', 'skills', 'mind-management')],
      ['cursor', join(tempHome, '.cursor', 'skills', 'mind-management')],
      ['gemini-cli', join(tempHome, '.gemini', 'skills', 'mind-management')],
      ['pi', join(tempHome, '.pi', 'agent', 'skills', 'mind-management')],
    ];

    for (const [agent, shadowDir] of cases) {
      mkdirSync(shadowDir, { recursive: true });
      writeFileSync(join(shadowDir, 'SKILL.md'), oldMindSkillContent());
      writeFileSync(join(shadowDir, 'notes.md'), 'keep me');

      const result = installMindManagementSkill(agent);

      expect({ agent, path: result.path }).toEqual({ agent, path: getAgentSkillPath(agent) });
      expect({ agent, shadowSkill: existsSync(join(shadowDir, 'SKILL.md')) }).toEqual({
        agent,
        shadowSkill: false,
      });
      expect({ agent, notes: readFileSync(join(shadowDir, 'notes.md'), 'utf-8') }).toEqual({
        agent,
        notes: 'keep me',
      });
      expect({ agent, backups: backupDirsFor(shadowDir).length }).toEqual({ agent, backups: 1 });
    }
  });

  test('removes a managed shadow directory that only contains SKILL.md', () => {
    const shadowDir = join(tempHome, '.config', 'opencode', 'skills', 'mind-management');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'SKILL.md'), oldMindSkillContent());

    installMindManagementSkill('opencode');

    expect(existsSync(shadowDir)).toBe(false);
    const backups = backupDirsFor(shadowDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(shadowDir), backups[0] as string, 'SKILL.md'), 'utf-8')).toBe(
      oldMindSkillContent()
    );
  });

  test('leaves a foreign shadow skill in place and warns', () => {
    ensureCanonicalSkill();
    const shadowDir = join(tempHome, '.cursor', 'skills', 'mind-management');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'SKILL.md'), foreignSkillContent());

    const result = installMindManagementSkill('cursor');

    expect(result.warnings.some(warning => warning.includes('foreign'))).toBe(true);
    expect(readFileSync(join(shadowDir, 'SKILL.md'), 'utf-8')).toBe(foreignSkillContent());
  });
});

describe('dedicated client directories', () => {
  test('backs up and replaces an old Mind-managed Claude copy with a symlink', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), oldMindSkillContent());

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBe(join(targetDir, 'SKILL.md'));
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);

    const backups = backupDirsFor(targetDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(targetDir), backups[0] as string, 'SKILL.md'), 'utf-8')).toBe(
      oldMindSkillContent()
    );
  });

  test('preserves extra files in a client directory and refreshes only SKILL.md', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), oldMindSkillContent());
    writeFileSync(join(targetDir, 'extra.md'), 'keep me');

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBe(join(targetDir, 'SKILL.md'));
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(renderMindManagementSkill());
    expect(readFileSync(join(targetDir, 'extra.md'), 'utf-8')).toBe('keep me');
    expect(readdirSync(targetDir).some(name => name.startsWith('SKILL.md.bak.'))).toBe(true);
  });

  test('leaves a foreign dedicated client skill in place and reports it', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), foreignSkillContent());

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBeNull();
    expect(result.warnings.some(warning => warning.includes('foreign'))).toBe(true);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(foreignSkillContent());
  });

  test('falls back to a managed copy when directory symlinks are unavailable', () => {
    const failingSymlink = (() => {
      const error = new Error('EPERM: operation not permitted');
      (error as NodeJS.ErrnoException).code = 'EPERM';
      throw error;
    }) as unknown as typeof symlinkSync;

    const first = installMindManagementSkill('claude-code', { symlinkSync: failingSymlink });
    const targetDir = getAgentSkillLayout('claude-code').targetDir;

    expect(first.path).toBe(join(targetDir, 'SKILL.md'));
    expect(first.warnings.some(warning => /managed copy/i.test(warning))).toBe(true);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(renderMindManagementSkill());

    const backupsBefore = readdirSync(targetDir).filter(n => n.startsWith('SKILL.md.bak.')).length;
    const second = installMindManagementSkill('claude-code', { symlinkSync: failingSymlink });

    expect(second.warnings.filter(warning => /managed copy/i.test(warning))).toHaveLength(0);
    expect(readdirSync(targetDir).filter(n => n.startsWith('SKILL.md.bak.')).length).toBe(
      backupsBefore
    );
  });
});
