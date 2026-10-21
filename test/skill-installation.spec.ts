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
import { isAgentIntegrationDetected } from '../src/cli/setup';
import {
  type AgentSkillType,
  ensureCanonicalSkill,
  getAgentSkillLayout,
  getAgentSkillPath,
  getAgentSkillSignalPaths,
  getCanonicalSkillDir,
  installMindManagementSkill,
  resolveSymlinkType,
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

function canonicalDir(): string {
  return getCanonicalSkillDir();
}

function canonicalFile(): string {
  return join(canonicalDir(), 'SKILL.md');
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

function markerOldContent(): string {
  return [SKILL_OWNERSHIP_MARKER, '', '# Old managed skill', '', 'stale body', ''].join('\n');
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

function backupNames(dirPath: string, prefix: string): string[] {
  return readdirSync(dirPath).filter(name => name.startsWith(prefix));
}

function backupDirsFor(dirPath: string): string[] {
  const parent = dirname(dirPath);
  const prefix = `${dirPath.split('/').pop()}.bak.`;
  return readdirSync(parent).filter(name => name.startsWith(prefix));
}

function skillBackupFiles(dirPath: string): string[] {
  return backupNames(dirPath, 'SKILL.md.bak.');
}

function createSymlink(target: string, linkPath: string, type: 'dir' | 'file' = 'dir'): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, type);
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
    expect(skillBackupFiles(canonicalDir())).toEqual([]);
  });

  test('backs up and updates an old copy without the ownership marker', () => {
    mkdirSync(canonicalDir(), { recursive: true });
    writeFileSync(canonicalFile(), oldMindSkillContent());

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());

    const backups = skillBackupFiles(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(canonicalDir(), backups[0] as string), 'utf-8')).toBe(
      oldMindSkillContent()
    );

    ensureCanonicalSkill();
    expect(skillBackupFiles(canonicalDir())).toHaveLength(1);
  });

  test('backs up and updates a marked copy whose content differs', () => {
    mkdirSync(canonicalDir(), { recursive: true });
    writeFileSync(canonicalFile(), markerOldContent());

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());

    const backups = skillBackupFiles(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(canonicalDir(), backups[0] as string), 'utf-8')).toBe(
      markerOldContent()
    );
  });

  test('updates a same-name canonical skill in the managed location', () => {
    mkdirSync(canonicalDir(), { recursive: true });
    writeFileSync(canonicalFile(), foreignSkillContent());

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());

    const backups = skillBackupFiles(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(canonicalDir(), backups[0] as string), 'utf-8')).toBe(
      foreignSkillContent()
    );
  });

  test('never modifies another skill beside mind-management', () => {
    const otherDir = join(tempHome, '.agents', 'skills', 'other-skill');
    const otherFile = join(otherDir, 'SKILL.md');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(otherFile, '# Other skill\n');

    installMindManagementSkill('opencode');

    expect(readFileSync(otherFile, 'utf-8')).toBe('# Other skill\n');
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());
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
      expect(realpathSync(targetDir)).toBe(realpathSync(canonicalDir()));
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

  test('migrates a same-name shadow skill in the managed legacy location', () => {
    ensureCanonicalSkill();
    const shadowDir = join(tempHome, '.cursor', 'skills', 'mind-management');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'SKILL.md'), foreignSkillContent());

    const result = installMindManagementSkill('cursor');

    expect(result.path).toBe(getAgentSkillPath('cursor'));
    expect(existsSync(join(shadowDir, 'SKILL.md'))).toBe(false);
    const backups = backupDirsFor(shadowDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(shadowDir), backups[0] as string, 'SKILL.md'), 'utf-8')).toBe(
      foreignSkillContent()
    );
  });
});

describe('dedicated client directories', () => {
  test('backs up and replaces an old managed Claude copy with a symlink', () => {
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
    expect(skillBackupFiles(targetDir)).toHaveLength(1);
  });

  test('updates a same-name dedicated client skill in the managed location', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'SKILL.md'), foreignSkillContent());

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBe(join(targetDir, 'SKILL.md'));
    expect(readFileSync(join(targetDir, 'SKILL.md'), 'utf-8')).toBe(renderMindManagementSkill());
    expect(backupDirsFor(targetDir)).toHaveLength(1);
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

    const backupsBefore = skillBackupFiles(targetDir).length;
    const second = installMindManagementSkill('claude-code', { symlinkSync: failingSymlink });

    expect(second.warnings.filter(warning => /managed copy/i.test(warning))).toHaveLength(0);
    expect(skillBackupFiles(targetDir)).toHaveLength(backupsBefore);
  });
});

describe('symlink safety', () => {
  test('replaces a foreign directory symlink without writing through it', () => {
    const externalDir = join(tempHome, 'external-skill');
    const externalFile = join(externalDir, 'SKILL.md');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(externalFile, 'EXTERNAL CONTENT');
    const mtimeBefore = lstatSync(externalFile).mtimeMs;
    createSymlink(externalDir, canonicalDir(), 'dir');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(lstatSync(canonicalDir()).isDirectory()).toBe(true);
    expect(lstatSync(canonicalDir()).isSymbolicLink()).toBe(false);
    expect(readFileSync(externalFile, 'utf-8')).toBe('EXTERNAL CONTENT');
    expect(lstatSync(externalFile).mtimeMs).toBe(mtimeBefore);

    const backups = backupDirsFor(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(canonicalDir()), backups[0] as string), 'utf-8')).toContain(
      `LINK_TARGET=${externalDir}`
    );
  });

  test('repairs a broken directory symlink and records the old target', () => {
    const missingTarget = join(tempHome, 'missing-target');
    createSymlink(missingTarget, canonicalDir(), 'dir');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(lstatSync(canonicalDir()).isDirectory()).toBe(true);
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());
    const backups = backupDirsFor(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(canonicalDir()), backups[0] as string), 'utf-8')).toContain(
      `LINK_TARGET=${missingTarget}`
    );
  });

  test('replaces a file-level SKILL.md symlink without touching its target', () => {
    mkdirSync(canonicalDir(), { recursive: true });
    const externalFile = join(tempHome, 'external-SKILL.md');
    writeFileSync(externalFile, 'EXTERNAL FILE CONTENT');
    const mtimeBefore = lstatSync(externalFile).mtimeMs;
    createSymlink(externalFile, canonicalFile(), 'file');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(lstatSync(canonicalFile()).isFile()).toBe(true);
    expect(readFileSync(externalFile, 'utf-8')).toBe('EXTERNAL FILE CONTENT');
    expect(lstatSync(externalFile).mtimeMs).toBe(mtimeBefore);
    const backups = skillBackupFiles(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(canonicalDir(), backups[0] as string), 'utf-8')).toContain(
      `LINK_TARGET=${externalFile}`
    );
  });

  test('replaces a foreign dedicated symlink and records its target', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    const externalDir = join(tempHome, 'external-claude-skill');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'SKILL.md'), 'EXTERNAL CLAUDE CONTENT');
    createSymlink(externalDir, targetDir, 'dir');

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBe(getAgentSkillPath('claude-code'));
    expect(realpathSync(targetDir)).toBe(realpathSync(canonicalDir()));
    expect(readFileSync(join(externalDir, 'SKILL.md'), 'utf-8')).toBe('EXTERNAL CLAUDE CONTENT');
    const backups = backupDirsFor(targetDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(targetDir), backups[0] as string), 'utf-8')).toContain(
      `LINK_TARGET=${externalDir}`
    );
  });
});

describe('portable repair behavior', () => {
  test('repairs a regular file used as the canonical skill directory without ENOTDIR', () => {
    mkdirSync(dirname(canonicalDir()), { recursive: true });
    writeFileSync(canonicalDir(), 'NOT A DIRECTORY');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(lstatSync(canonicalDir()).isDirectory()).toBe(true);
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());
    const backups = backupDirsFor(canonicalDir());
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(canonicalDir()), backups[0] as string), 'utf-8')).toBe(
      'NOT A DIRECTORY'
    );
  });

  test('repairs a regular file used as a dedicated skill path without ENOTDIR', () => {
    ensureCanonicalSkill();
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    mkdirSync(dirname(targetDir), { recursive: true });
    writeFileSync(targetDir, 'NOT A DIRECTORY');

    const result = installMindManagementSkill('claude-code');

    expect(result.path).toBe(getAgentSkillPath('claude-code'));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(lstatSync(targetDir).isSymbolicLink() || lstatSync(targetDir).isDirectory()).toBe(true);
    expect(readFileSync(getAgentSkillPath('claude-code'), 'utf-8')).toBe(
      renderMindManagementSkill()
    );
    expect(backupDirsFor(targetDir)).toHaveLength(1);
  });

  test('repairs a regular file at ~/.agents instead of throwing ENOTDIR', () => {
    writeFileSync(join(tempHome, '.agents'), 'BLOCKING AGENTS FILE');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());
    const backups = backupNames(tempHome, '.agents.bak.');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tempHome, backups[0] as string), 'utf-8')).toBe(
      'BLOCKING AGENTS FILE'
    );
  });

  test('repairs a regular file at ~/.agents/skills instead of throwing ENOTDIR', () => {
    mkdirSync(join(tempHome, '.agents'), { recursive: true });
    writeFileSync(join(tempHome, '.agents', 'skills'), 'BLOCKING SKILLS FILE');

    const result = ensureCanonicalSkill();

    expect(result.path).toBe(canonicalFile());
    expect(readFileSync(canonicalFile(), 'utf-8')).toBe(renderMindManagementSkill());
    const backups = backupNames(join(tempHome, '.agents'), 'skills.bak.');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tempHome, '.agents', backups[0] as string), 'utf-8')).toBe(
      'BLOCKING SKILLS FILE'
    );
  });

  test('repairs a regular file at ~/.claude for Claude Code instead of throwing ENOTDIR', () => {
    writeFileSync(join(tempHome, '.claude'), 'BLOCKING CLAUDE FILE');

    const result = installMindManagementSkill('claude-code');
    const targetDir = getAgentSkillLayout('claude-code').targetDir;

    expect(result.path).toBe(getAgentSkillPath('claude-code'));
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(getAgentSkillPath('claude-code'), 'utf-8')).toBe(
      renderMindManagementSkill()
    );
    const backups = backupNames(tempHome, '.claude.bak.');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tempHome, backups[0] as string), 'utf-8')).toBe(
      'BLOCKING CLAUDE FILE'
    );
  });

  test('resolves the Windows link type through a pure seam', () => {
    expect(resolveSymlinkType('win32')).toBe('junction');
    expect(resolveSymlinkType('linux')).toBe('dir');
    expect(resolveSymlinkType('darwin')).toBe('dir');
  });
});

describe('skill detection', () => {
  test('detects a dedicated client from a broken managed symlink so it can be repaired', () => {
    installMindManagementSkill('claude-code');
    const targetDir = getAgentSkillLayout('claude-code').targetDir;
    createSymlink(join(tempHome, 'gone'), targetDir, 'dir');

    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(isAgentIntegrationDetected('claude-code')).toBe(true);
  });
});
