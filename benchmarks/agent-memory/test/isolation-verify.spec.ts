import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { CommandInvocation } from '../src/exec';
import { isolationDirs } from '../src/isolation/opencode';
import { ContaminationError, verifyIsolation } from '../src/isolation/verify';
import { createFakeRunner, type FakeCommandResolver } from '../src/testing/fakes';

const conditionDir = mkdtempSync(join(tmpdir(), 'bench-verify-'));
const dir = isolationDirs(conditionDir);
const env = { HOME: dir.home, XDG_CONFIG_HOME: dir.config };

interface Overrides {
  pathLeak?: boolean;
  extraMcp?: boolean;
  sessions?: string;
  skills?: string;
}

function goodResolver(overrides: Overrides = {}): FakeCommandResolver {
  const pathLines = (['home', 'data', 'cache', 'config', 'state'] as const)
    .map(k => `${k} ${dir[k]}`)
    .join('\n');
  const leak = overrides.pathLeak ? `\nleak /home/user/.config/opencode` : '';
  const servers: Record<string, unknown> = { mind: { type: 'local', command: ['/x/mind', 'mcp'] } };
  if (overrides.extraMcp) servers['rogue'] = { type: 'local', command: ['/x/rogue', 'mcp'] };

  return (inv: CommandInvocation) => {
    const key = inv.args.join(' ');
    if (key === 'debug paths') return { stdout: `${pathLines}${leak}\n` };
    if (key === 'debug config') {
      return {
        stdout: JSON.stringify([
          {
            type: 'document',
            info: {
              $schema: 'https://opencode.ai/config.json',
              model: { providerID: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
              mcp: { servers },
            },
          },
        ]),
      };
    }
    if (key === 'mcp list') return { stdout: 'mind  pending\n' };
    if (key === 'session list --format json') return { stdout: overrides.sessions ?? '[]' };
    if (key === 'api get /api/agent') return { stdout: '{"data":[]}' };
    if (key === 'api get /api/skill')
      return { stdout: overrides.skills ?? '{"data":[{"id":"opencode"},{"id":"report"}]}' };
    if (key === 'api get /api/command') return { stdout: '{"data":[]}' };
    if (key === 'api get /api/plugin') return { stdout: '{"data":[{"id":"opencode.tool.read"}]}' };
    return { stdout: '' };
  };
}

async function verify(
  resolver: FakeCommandResolver,
  condition: 'mind-v10' | 'no-memory' = 'mind-v10'
) {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'bench-verify-evid-'));
  const fake = createFakeRunner(resolver);
  return verifyIsolation({ condition, dir, env, runner: fake.runner, evidenceDir });
}

describe('verifyIsolation', () => {
  test('passes for a clean mind condition and saves evidence', async () => {
    const report = await verify(goodResolver());
    expect(report.ok).toBe(true);
    expect(report.condition).toBe('mind-v10');
    expect(existsSync(join(report.evidenceDir!, 'summary.txt'))).toBe(true);
    expect(existsSync(join(report.evidenceDir!, 'debug-config.stdout.txt'))).toBe(true);
  });

  test('passes for a clean no-memory condition', async () => {
    const resolver: FakeCommandResolver = inv => {
      const key = inv.args.join(' ');
      if (key === 'debug paths') return { stdout: `home ${dir.home}\n` };
      if (key === 'debug config')
        return {
          stdout: JSON.stringify([
            {
              type: 'document',
              info: { model: { providerID: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } },
            },
          ]),
        };
      if (key === 'mcp list') return { stdout: 'No MCP servers configured\n' };
      if (key === 'session list --format json') return { stdout: '[]' };
      return { stdout: '{"data":[]}' };
    };
    const report = await verify(resolver, 'no-memory');
    expect(report.ok).toBe(true);
  });

  test('fails closed on a path leak and writes dumps', async () => {
    const promise = verify(goodResolver({ pathLeak: true }));
    await expect(promise).rejects.toThrow(ContaminationError);
    try {
      await promise;
    } catch (error) {
      const contamination = error as ContaminationError;
      expect(contamination.reasons.some(r => r.includes('paths-under-condition-dir'))).toBe(true);
      expect(existsSync(join(contamination.report.evidenceDir!, 'debug-paths.stdout.txt'))).toBe(
        true
      );
    }
  });

  test('fails when an unauthorized MCP server is present', async () => {
    await expect(verify(goodResolver({ extraMcp: true }))).rejects.toThrow(ContaminationError);
  });

  test('fails when sessions leak', async () => {
    await expect(verify(goodResolver({ sessions: '[{"id":"ses_user"}]' }))).rejects.toThrow(
      ContaminationError
    );
  });

  test('fails when a user skill leaks', async () => {
    await expect(
      verify(goodResolver({ skills: '{"data":[{"id":"opencode"},{"id":"user-private"}]}' }))
    ).rejects.toThrow(ContaminationError);
  });

  test('proves mind-current runs the expected local checkout binary', async () => {
    const fake = createFakeRunner(goodResolver());
    const report = await verifyIsolation({
      condition: 'mind-current',
      dir,
      env,
      runner: fake.runner,
      evidenceDir: mkdtempSync(join(tmpdir(), 'bench-verify-evid-')),
      mindBin: '/x/mind',
    });
    expect(report.ok).toBe(true);
  });

  test('fails closed when mind-current is wired to a different binary', async () => {
    const fake = createFakeRunner(goodResolver());
    await expect(
      verifyIsolation({
        condition: 'mind-current',
        dir,
        env,
        runner: fake.runner,
        evidenceDir: mkdtempSync(join(tmpdir(), 'bench-verify-evid-')),
        mindBin: '/somewhere/else/mind',
      })
    ).rejects.toThrow(ContaminationError);
  });
});
