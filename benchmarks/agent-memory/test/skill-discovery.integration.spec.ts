// Free integration test for OpenCode skill-first discovery.
//
// Gated behind BENCH_INTEGRATION=1 and skipped when `opencode` is not on PATH.
// It installs the real canonical skill + L2 activation through
// `mind setup opencode` in an isolated HOME, then queries OpenCode's config and
// skill registry. No model is called and no live home/database is touched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { BUILTIN_SKILLS } from '../src/config';
import { runCommand, type CommandRunner } from '../src/exec';
import { buildOpenCodeEnv, ensureIsolationDirs, isolationDirs } from '../src/isolation/opencode';
import {
  ContaminationError,
  findFreePort,
  verifyIsolation,
  writeIsolatedServicePort,
} from '../src/isolation/verify';

const SKILL_ID = 'mind-management';
/** Built-in OpenCode 2.0.28 agents; allowed so async registration is not a leak. */
const BUILTIN_AGENTS = [
  'build',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
  'plan',
] as const;
const HARNESS_ROOT = join(import.meta.dir, '..');
const REPO_ROOT = resolve(HARNESS_ROOT, '..', '..');
const MIND_BIN = join(REPO_ROOT, 'mind');

const opencodeBin = Bun.which('opencode');
const enabled = process.env.BENCH_INTEGRATION === '1' && Boolean(opencodeBin);

interface SkillEntry {
  readonly id?: unknown;
}

function parseSkillIds(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { data?: SkillEntry[] };
    return (parsed.data ?? [])
      .map(entry => (typeof entry.id === 'string' ? entry.id : ''))
      .filter(id => id.length > 0);
  } catch {
    return [];
  }
}

async function runOpencode(
  bin: string,
  env: Record<string, string>,
  workspace: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runCommand({
    command: bin,
    args,
    cwd: workspace,
    env: { ...process.env, ...env },
    timeoutMs: 120_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/**
 * OpenCode registers filesystem skills asynchronously after the managed service
 * boots. Poll the list endpoint until the skill appears (or the budget runs out)
 * instead of assuming the first call is complete.
 */
async function waitForSkill(
  bin: string,
  env: Record<string, string>,
  workspace: string,
  runner: CommandRunner,
  skillId: string,
  attempts = 20,
  delayMs = 750
): Promise<string[]> {
  let ids: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await runner({
      command: bin,
      args: ['api', 'get', '/api/skill'],
      cwd: workspace,
      env: { ...process.env, ...env },
      timeoutMs: 60_000,
    });
    ids = parseSkillIds(result.stdout);
    if (ids.includes(skillId)) return ids;
    await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
  }
  return ids;
}

describe.skipIf(!enabled)('OpenCode skill discovery (integration)', () => {
  test('discovers the canonical skill, its L2 activation and a clean MCP registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-skill-discovery-'));
    try {
      // The product setup writes under HOME/.config; the benchmark session uses
      // its own XDG config root so the managed L3 plugin is not auto-loaded.
      const dirs = isolationDirs(root);
      ensureIsolationDirs(dirs);
      const setupConfigRoot = join(dirs.home, '.config');
      mkdirSync(join(setupConfigRoot, 'opencode'), { recursive: true });

      const setupEnv: Record<string, string> = {
        HOME: dirs.home,
        XDG_CONFIG_HOME: setupConfigRoot,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        MIND_DB_PATH: dirs.mindDb,
        MIND_DATA_DIR: dirs.mindDataDir,
        MIND_SYNC_ROOT: dirs.syncRoot,
        MIND_RAG: 'false',
      };
      const setup = await runOpencode(MIND_BIN, setupEnv, dirs.workspace, [
        'setup',
        'opencode',
      ]).catch(error => ({
        stdout: '',
        stderr: String(error),
        exitCode: 1,
      }));
      expect(setup.exitCode, setup.stderr || setup.stdout).toBe(0);

      const canonicalSkill = join(dirs.home, '.agents', 'skills', SKILL_ID, 'SKILL.md');
      expect(existsSync(canonicalSkill)).toBe(true);

      const instructionPath = join(
        setupConfigRoot,
        'opencode',
        'instructions',
        'mind-memory-protocol.md'
      );
      expect(existsSync(instructionPath)).toBe(true);
      const activation = readFileSync(instructionPath, 'utf8');
      expect(activation).toContain(`\`${SKILL_ID}\` skill`);
      // The L2 file is the brief activation, not the full protocol body.
      expect(activation).not.toContain('## ORIENT');
      expect(activation.length).toBeLessThan(2_000);

      const configPath = join(setupConfigRoot, 'opencode', 'opencode.jsonc');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        instructions?: unknown;
        mcp?: unknown;
      };
      expect(config.instructions).toContain(instructionPath);
      expect(JSON.stringify(config.mcp)).toContain('mind');

      // Give the isolated session the same L2 activation the setup installed,
      // without loading the setup-managed L3 plugin.
      const env = buildOpenCodeEnv({ condition: 'mind-current', dir: dirs, mindBin: MIND_BIN });
      const sessionConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
        instructions?: string[];
      };
      sessionConfig.instructions = [instructionPath];
      env.OPENCODE_CONFIG_CONTENT = `${JSON.stringify(sessionConfig, null, 2)}\n`;
      writeIsolatedServicePort(dirs, await findFreePort());

      const debugConfig = await runOpencode(opencodeBin!, env, dirs.workspace, ['debug', 'config']);
      expect(debugConfig.exitCode).toBe(0);
      expect(debugConfig.stdout).toContain(instructionPath);

      const skills = await waitForSkill(opencodeBin!, env, dirs.workspace, runCommand, SKILL_ID);
      expect(skills).toContain(SKILL_ID);
      // Only the installed skill plus OpenCode's built-ins are visible.
      expect(skills.filter(id => !BUILTIN_SKILLS.includes(id) && id !== SKILL_ID)).toEqual([]);

      // The fail-closed gate must treat the installed skill as allowed, not as
      // contamination, while still pinning the model and the single mind server.
      writeIsolatedServicePort(dirs, await findFreePort());
      const report = await verifyIsolation({
        condition: 'mind-current',
        dir: dirs,
        env,
        runner: runCommand,
        evidenceDir: join(root, 'isolation-evidence'),
        mindBin: MIND_BIN,
        allowedAgents: [...BUILTIN_AGENTS],
        sleep: async () => undefined,
      });
      expect(report.ok).toBe(true);
      const skillsCheck = report.checks.find(check => check.name === 'skills-allowlisted');
      expect(skillsCheck?.ok).toBe(true);
      const skillFirstCheck = report.checks.find(check => check.name === 'skill-first');
      expect(skillFirstCheck?.ok).toBe(true);
      expect(existsSync(join(root, 'isolation-evidence', 'summary.txt'))).toBe(true);

      // A foreign user skill must be rejected by the condition-derived surface.
      const foreignId = 'foreign-skill';
      const foreignDir = join(dirs.home, '.agents', 'skills', foreignId);
      mkdirSync(foreignDir, { recursive: true });
      writeFileSync(
        join(foreignDir, 'SKILL.md'),
        '---\nname: foreign-skill\n---\n\nbody\n',
        'utf8'
      );
      const discovered = await waitForSkill(
        opencodeBin!,
        env,
        dirs.workspace,
        runCommand,
        foreignId
      );
      expect(discovered).toContain(foreignId);
      await expect(
        verifyIsolation({
          condition: 'mind-current',
          dir: dirs,
          env,
          runner: runCommand,
          evidenceDir: join(root, 'isolation-evidence-foreign'),
          mindBin: MIND_BIN,
          allowedAgents: [...BUILTIN_AGENTS],
          sleep: async () => undefined,
        })
      ).rejects.toThrow(ContaminationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
