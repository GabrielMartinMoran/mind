import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { getSupportedAgents, type SupportedAgent } from '../src/cli/capabilities';
import { executeCommand } from '../src/cli/command-executor';
import { renderMemoryProtocol } from '../src/cli/memory-protocol';
import {
  buildClaudeMcpAddArgs,
  getAgentCapabilityMatrix,
  getAgentCapabilities,
  isAgentIntegrationDetected,
  listAgents,
  runSetup,
  runSetupRefresh,
} from '../src/cli/setup';
import { readTomlOrThrow } from '../src/setup/safe-config';
import { installMindManagementSkill } from '../src/setup/skill-installation';

import { mockedLogger } from './mocks/mocked-logger';
import { createTestStore } from './mocks/test-store';

let previousHome = '';
let previousClaudeHooksOptIn = '';
let tempHome = '';

beforeEach(() => {
  previousHome = process.env.HOME ?? '';
  previousClaudeHooksOptIn = process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS ?? '';
  tempHome = mkdtempSync(join(tmpdir(), 'mind-setup-capabilities-'));
  process.env.HOME = tempHome;
  delete process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS;
});

afterEach(() => {
  process.env.HOME = previousHome;
  if (previousClaudeHooksOptIn.length > 0) {
    process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS = previousClaudeHooksOptIn;
  } else {
    delete process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS;
  }
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('Setup capability model', () => {
  test('declares explicit per-level capability status for each configured agent', () => {
    const matrix = getAgentCapabilityMatrix();
    expect(matrix.length).toBeGreaterThanOrEqual(6);

    const cursor = getAgentCapabilities('cursor');
    expect(cursor.L1_MCP.status).toBe('supported');
    expect(cursor.L2_INSTRUCTIONS.status).toBe('unverified');
    // The documented hooks schema is emitted but was never live-validated.
    expect(cursor.L3_HOOKS.status).toBe('unverified');

    const codex = getAgentCapabilities('codex');
    expect(codex.L1_MCP.status).toBe('supported');
    expect(codex.L2_INSTRUCTIONS.status).toBe('supported');
    expect(codex.L3_HOOKS.status).toBe('unsupported');

    const opencode = getAgentCapabilities('opencode');
    expect(opencode.L2_INSTRUCTIONS.status).toBe('supported');
    expect(opencode.L3_HOOKS.status).toBe('supported');

    const claude = getAgentCapabilities('claude-code');
    expect(claude.L2_INSTRUCTIONS.status).toBe('supported');
    expect(claude.L3_HOOKS.status).toBe('supported');

    const pi = getAgentCapabilities('pi');
    expect(pi.L1_MCP.status).toBe('supported');
    expect(pi.L2_INSTRUCTIONS.status).toBe('supported');
    // Pi documents extensions, but Mind deliberately does not build a Pi plugin.
    expect(pi.L3_HOOKS.status).toBe('unverified');
  });

  test('publishes skill metadata for every agent and a documented Pi entry', () => {
    const matrix = getAgentCapabilityMatrix();
    const pi = matrix.find(entry => entry.agent === 'pi');
    expect(pi).toBeDefined();
    expect(pi?.name).toBe('Pi Agent');
    expect(pi?.skill?.status).toBe('supported');
    expect(pi?.skill?.strategy).toBe('shared');
    expect(pi?.skill?.path).toBe('~/.agents/skills/mind-management');

    for (const entry of matrix) {
      expect({ agent: entry.agent, skill: Boolean(entry.skill) }).toEqual({
        agent: entry.agent,
        skill: true,
      });
      expect(['shared', 'symlink', 'copy']).toContain(entry.skill?.strategy as string);
    }

    expect(matrix.find(entry => entry.agent === 'claude-code')?.skill?.strategy).toBe('symlink');
    expect(matrix.find(entry => entry.agent === 'antigravity')?.skill?.strategy).toBe('symlink');
  });

  test('records documented MCP paths and honest hook statuses', () => {
    const windsurf = getAgentCapabilities('windsurf');
    expect(windsurf.L1_MCP.evidence).toContain('~/.config/devin/mcp_config.json');

    const vscode = getAgentCapabilities('vscode');
    expect(vscode.L1_MCP.evidence).toContain('~/.copilot/mcp-config.json');

    const antigravity = getAgentCapabilities('antigravity');
    expect(antigravity.L1_MCP.evidence).toContain('~/.gemini/config/mcp_config.json');

    for (const agent of ['codex', 'gemini-cli', 'vscode', 'antigravity'] as const) {
      const hooks = getAgentCapabilities(agent).L3_HOOKS;
      expect(hooks.status).toBe('unsupported');
      expect(hooks.evidence.toLowerCase()).toContain('not implement');
    }
  });

  test('prints explicit capability diagnostics for Claude setup with supported L2/L3', async () => {
    const logSpy = spyOn(console, 'log');

    await runSetup('claude-code');

    const lines = logSpy.mock.calls.map(call => String(call[0]));
    // Check for compact capability badges (new format)
    expect(
      lines.some(
        line => line.includes('L2 inject') && line.includes('supported') && line.includes('high')
      )
    ).toBe(true);

    expect(
      lines.some(
        line => line.includes('L3 hooks') && line.includes('supported') && line.includes('medium')
      )
    ).toBe(true);
  });

  test('no roadmap agents in capability matrix', () => {
    const matrix = getAgentCapabilityMatrix();
    const agentNames = matrix.map(entry => entry.agent);

    expect(agentNames).toContain('vscode');
    expect(agentNames).toContain('antigravity');
    // OpenClaw and Kiro are no longer present (removed from experimental/roadmap)
    expect(agentNames).not.toContain('openclaw');
    expect(agentNames).not.toContain('kiro');

    const vscode = matrix.find(entry => entry.agent === 'vscode');
    expect(vscode?.capabilities.L1_MCP.status).toBe('supported');
    expect(vscode?.capabilities.L2_INSTRUCTIONS.status).toBe('unsupported');
    expect(vscode?.capabilities.L3_HOOKS.status).toBe('unsupported');

    // Antigravity is now a supported agent with L1 MCP
    const antigravity = matrix.find(entry => entry.agent === 'antigravity');
    expect(antigravity?.name).toBe('Antigravity');
    expect(antigravity?.capabilities.L1_MCP.status).toBe('supported');
    expect(antigravity?.capabilities.L2_INSTRUCTIONS.status).toBe('unsupported');
    expect(antigravity?.capabilities.L3_HOOKS.status).toBe('unsupported');
  });

  test('compatibility output exposes capability statuses and evidence notes', () => {
    const logSpy = spyOn(console, 'log');

    listAgents();

    const lines = logSpy.mock.calls.map(call => String(call[0]));
    // Compatibility output uses a clear heading and compact capability badges.
    expect(lines.some(line => line.includes('🧠 Agent Compatibility'))).toBe(true);
    expect(lines.some(line => line.includes('Cursor'))).toBe(true);
    // Capability badges show ⚠️ for unverified status
    expect(lines.some(line => line.includes('⚠️'))).toBe(true);
    // Skill metadata is printed separately from the L1/L2/L3 badges.
    expect(lines.some(line => line.includes('skill') && line.includes('shared'))).toBe(true);
    expect(
      lines.some(
        line => line.includes('skill') && line.includes('~/.agents/skills/mind-management') // documented path
      )
    ).toBe(true);
  });

  test('bare setup configures every supported agent integration', async () => {
    const store = createTestStore();
    const logSpy = spyOn(console, 'log');

    try {
      await executeCommand(['setup'], store, mockedLogger());

      const agents = getSupportedAgents() as SupportedAgent[];
      expect(agents.length).toBeGreaterThan(1);
      for (const agent of agents) {
        expect(isAgentIntegrationDetected(agent)).toBe(true);
      }

      expect(
        logSpy.mock.calls.some(call =>
          String(call[0]).includes(`Setup complete for all ${agents.length} supported agents`)
        )
      ).toBe(true);
    } finally {
      store.cleanup();
    }
  });

  test('setup compatibility displays the matrix without configuring agents', async () => {
    const store = createTestStore();
    const logSpy = spyOn(console, 'log');

    try {
      await executeCommand(['setup', 'compatibility'], store, mockedLogger());

      const lines = logSpy.mock.calls.map(call => String(call[0]));
      expect(lines.some(line => line.includes('🧠 Agent Compatibility'))).toBe(true);
      expect(lines.some(line => line.includes('Cursor'))).toBe(true);
      for (const agent of getSupportedAgents() as SupportedAgent[]) {
        expect(isAgentIntegrationDetected(agent)).toBe(false);
      }
    } finally {
      store.cleanup();
    }
  });

  test('setup refresh keeps its detected integration behavior', async () => {
    const store = createTestStore();
    const logSpy = spyOn(console, 'log');

    try {
      await executeCommand(['setup', 'refresh', '--dry-run'], store, mockedLogger());

      expect(
        logSpy.mock.calls.some(call =>
          String(call[0]).includes('No detected mind integrations to refresh')
        )
      ).toBe(true);
      for (const agent of getSupportedAgents() as SupportedAgent[]) {
        expect(isAgentIntegrationDetected(agent)).toBe(false);
      }
    } finally {
      store.cleanup();
    }
  });

  test('keeps Cursor L1 setup behavior while configuring managed global hooks artifacts', async () => {
    await runSetup('cursor');
    await runSetup('cursor');

    const configPath = join(tempHome, '.cursor', 'mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({ MIND_AGENT: 'cursor' });

    const hooksPath = join(tempHome, '.cursor', 'hooks.json');
    const hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    // Documented Cursor schema: { version: 1, hooks: { <event>: [...] } }.
    expect(hooksConfig.version).toBe(1);
    expect(hooksConfig.sessionStart).toBeUndefined();
    expect(Array.isArray(hooksConfig.hooks.sessionStart)).toBe(true);
    expect(Array.isArray(hooksConfig.hooks.preCompact)).toBe(true);
    expect(Array.isArray(hooksConfig.hooks.sessionEnd)).toBe(true);
    expect(Array.isArray(hooksConfig.hooks.stop)).toBe(true);

    const hookScriptPath = join(tempHome, '.cursor', 'hooks', 'mind-session-continuity.sh');
    const hookScript = readFileSync(hookScriptPath, 'utf-8');
    // Hooks must never create, overwrite, or complete a checkpoint.
    expect(hookScript).not.toContain('checkpoint set');
    expect(hookScript).not.toMatch(/checkpoint\s+(set|done|complete|recover)/);
    expect(hookScript).not.toContain('Capture active goal');
    expect(hookScript).not.toContain('Snapshot context');
    expect(hookScript).not.toContain('Persist final continuity');
    expect(hookScript).not.toContain('--history');
    expect(hookScript).toContain('mind-management');

    for (const eventName of ['sessionStart', 'preCompact', 'sessionEnd', 'stop']) {
      const matches = (hooksConfig.hooks[eventName] as Array<Record<string, any>>).filter(
        entry => entry?.command === hookScriptPath
      );
      expect({ eventName, matches: matches.length }).toEqual({ eventName, matches: 1 });
    }
  });

  test('keeps Cursor hooks setup non-destructive for existing hooks entries', async () => {
    const cursorDir = join(tempHome, '.cursor');
    const hooksPath = join(cursorDir, 'hooks.json');

    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: '/custom/start.sh' }],
            customEvent: [{ command: '/custom/other.sh' }],
          },
        },
        null,
        2
      )
    );

    await runSetup('cursor');

    const config = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    expect(config.hooks.customEvent).toEqual([{ command: '/custom/other.sh' }]);
    expect(
      (config.hooks.sessionStart as Array<Record<string, any>>).some(
        entry => entry.command === '/custom/start.sh'
      )
    ).toBe(true);
  });

  test('deduplicates dirty Cursor managed hook entries across reruns', async () => {
    const cursorDir = join(tempHome, '.cursor');
    const hooksPath = join(cursorDir, 'hooks.json');
    const hookScriptPath = join(cursorDir, 'hooks', 'mind-session-continuity.sh');

    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              { command: hookScriptPath, args: ['sessionStart'] },
              { command: hookScriptPath, args: ['sessionStart'] },
            ],
            preCompact: [{ command: hookScriptPath, args: ['preCompact'] }],
            sessionEnd: [{ command: hookScriptPath, args: ['sessionEnd'] }],
            stop: [
              { command: hookScriptPath, args: ['stop'] },
              { command: hookScriptPath, args: ['stop'] },
            ],
          },
        },
        null,
        2
      )
    );

    await runSetup('cursor');
    await runSetup('cursor');

    const config = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    for (const eventName of ['sessionStart', 'preCompact', 'sessionEnd', 'stop']) {
      expect({
        eventName,
        managed: (config.hooks[eventName] as Array<Record<string, any>>).filter(
          entry => entry.command === hookScriptPath && entry.args?.[0] === eventName
        ).length,
      }).toEqual({ eventName, managed: 1 });
    }
  });

  test('keeps Windsurf L1 setup behavior while leaving L2/L3 unsupported', async () => {
    await runSetup('windsurf');

    // Documented path for Windsurf/Devin; the old ~/.windsurf path is legacy.
    const configPath = join(tempHome, '.config', 'devin', 'mcp_config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({ MIND_AGENT: 'windsurf' });
    expect(existsSync(join(tempHome, '.windsurf', 'mcp.json'))).toBe(false);

    const capabilities = getAgentCapabilities('windsurf');
    expect(capabilities.L2_INSTRUCTIONS.status).toBe('unsupported');
    expect(capabilities.L3_HOOKS.status).toBe('unsupported');
  });

  test('writes VS Code Copilot and Antigravity MCP files at their documented paths', async () => {
    await runSetup('vscode');
    await runSetup('antigravity');

    const vscodePath = join(tempHome, '.copilot', 'mcp-config.json');
    const vscode = JSON.parse(readFileSync(vscodePath, 'utf-8')) as Record<string, any>;
    expect(vscode.mcpServers.mind.type).toBe('stdio');
    expect(vscode.mcpServers.mind.args).toEqual(['mcp']);
    expect(existsSync(join(tempHome, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);

    const antigravityPath = join(tempHome, '.gemini', 'config', 'mcp_config.json');
    const antigravity = JSON.parse(readFileSync(antigravityPath, 'utf-8')) as Record<string, any>;
    expect(antigravity.mcpServers.mind.type).toBe('stdio');
    expect(antigravity.mcpServers.mind.args).toEqual(['mcp']);
  });

  test('configures Pi with MCP, a brief AGENTS.md pointer, and the shared skill', async () => {
    const piDir = join(tempHome, '.pi', 'agent');
    const agentsPath = join(piDir, 'AGENTS.md');

    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      agentsPath,
      ['# Existing Pi Instructions', '', 'Keep this custom section.', '', '## Footer notes'].join(
        '\n'
      )
    );

    await runSetup('pi');
    await runSetup('pi');

    const configPath = join(piDir, 'mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({ MIND_AGENT: 'pi' });

    const agentsMd = readFileSync(agentsPath, 'utf-8');
    expect(agentsMd).toContain('# Existing Pi Instructions');
    expect(agentsMd).toContain('## Footer notes');
    expect(agentsMd).toContain('mind managed protocol start');
    expect(agentsMd).toContain('mind managed protocol end');
    expect(agentsMd).toContain('## Mind activation pointer (managed)');
    expect(agentsMd).toContain('mind-management');
    expect(agentsMd).not.toContain('## ORIENT');
    expect(agentsMd).toContain(renderMemoryProtocol('pi').trim());
    expect(agentsMd.split('<!-- mind managed protocol start -->').length - 1).toBe(1);

    // Shared canonical skill, never a Pi-specific copy.
    expect(existsSync(join(tempHome, '.agents', 'skills', 'mind-management', 'SKILL.md'))).toBe(
      true
    );
    expect(existsSync(join(piDir, 'plugins', 'mind-automation.js'))).toBe(false);
    expect(existsSync(join(piDir, 'extensions'))).toBe(false);

    expect(isAgentIntegrationDetected('pi')).toBe(true);
  });

  test('refreshes a detected Pi integration without creating unrelated configs', async () => {
    const piDir = join(tempHome, '.pi', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { mind: { command: '/stale/mind', args: ['mcp'] } } }, null, 2)
    );

    const result = await runSetupRefresh({ mode: 'detected' });

    expect(result.refreshedAgents).toEqual(['pi']);
    const refreshed = JSON.parse(readFileSync(join(piDir, 'mcp.json'), 'utf-8')) as Record<
      string,
      any
    >;
    expect(refreshed.mcpServers.mind.command).toEqual(expect.any(String));
    expect(readFileSync(join(piDir, 'AGENTS.md'), 'utf-8')).toContain(
      'mind managed protocol start'
    );
    expect(existsSync(join(tempHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  test('prints explicit fallback diagnostics for Gemini unsupported L2/L3', async () => {
    const logSpy = spyOn(console, 'log');

    await runSetup('gemini-cli');

    const lines = logSpy.mock.calls.map(call => String(call[0]));
    // Check for compact capability badges (new format)
    expect(lines.some(line => line.includes('L2 inject') && line.includes('unsupported'))).toBe(
      true
    );
    expect(lines.some(line => line.includes('L3 hooks') && line.includes('unsupported'))).toBe(
      true
    );
  });

  test('configures Codex with local stdio MCP command transport', async () => {
    await runSetup('codex');

    const configPath = join(tempHome, '.codex', 'config.toml');
    const configToml = readFileSync(configPath, 'utf-8');

    expect(configToml).toContain('[mcp_servers.mind]');
    expect(configToml).toContain('args = ["mcp"]');
    expect(configToml).not.toContain('--http');
  });

  test('injects managed Codex protocol instructions into global AGENTS.md non-destructively and idempotently', async () => {
    const codexDir = join(tempHome, '.codex');
    const agentsPath = join(codexDir, 'AGENTS.md');

    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      agentsPath,
      [
        '# Existing Codex Instructions',
        '',
        'Keep this custom section.',
        '',
        '## Footer notes',
      ].join('\n')
    );

    await runSetup('codex');
    await runSetup('codex');

    const agentsMd = readFileSync(agentsPath, 'utf-8');
    expect(agentsMd).toContain('# Existing Codex Instructions');
    expect(agentsMd).toContain('## Footer notes');
    expect(agentsMd).toContain('mind managed protocol start');
    expect(agentsMd).toContain('mind managed protocol end');
    expect(agentsMd).toContain('## Mind activation pointer (managed)');
    expect(agentsMd).toContain('mind-management');
    expect(agentsMd).toContain(
      'The source of truth is the `mind-management` skill, not this file.'
    );
    expect(agentsMd).toContain('unconditionally');
    expect(agentsMd).toContain('system_instructions');
    expect(agentsMd).not.toContain('## ORIENT');
    expect(agentsMd).not.toContain('**Trigger:**');
    expect(agentsMd).not.toContain('```json tool:');
    expect(agentsMd).toContain(renderMemoryProtocol('codex').trim());

    const startCount = agentsMd.split('<!-- mind managed protocol start -->').length - 1;
    const endCount = agentsMd.split('<!-- mind managed protocol end -->').length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  test('repairs dirty Codex managed protocol blocks and removes legacy protocol files', async () => {
    const codexDir = join(tempHome, '.codex');
    const agentsPath = join(codexDir, 'AGENTS.md');
    const legacyProtocolPath = join(codexDir, 'mind-memory-protocol-codex.md');

    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      agentsPath,
      [
        '# Codex Notes',
        '',
        '<!-- mind managed protocol start -->',
        'stale 1',
        '<!-- mind managed protocol end -->',
        '',
        '<!-- mind managed protocol start -->',
        'stale 2',
        '<!-- mind managed protocol end -->',
      ].join('\n')
    );
    writeFileSync(legacyProtocolPath, '# stale codex protocol');

    await runSetup('codex');
    await runSetup('codex');

    const agentsMd = readFileSync(agentsPath, 'utf-8');
    expect(agentsMd.split('<!-- mind managed protocol start -->').length - 1).toBe(1);
    expect(agentsMd.split('<!-- mind managed protocol end -->').length - 1).toBe(1);
    expect(existsSync(legacyProtocolPath)).toBe(false);
  });

  test('injects managed Claude protocol instructions into global CLAUDE.md', async () => {
    await runSetup('claude-code');

    const claudeMdPath = join(tempHome, '.claude', 'CLAUDE.md');
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');

    expect(claudeMd).toContain('mind managed protocol start');
    expect(claudeMd).toContain('## Mind activation pointer (managed)');
    expect(claudeMd).toContain('mind-management');
    expect(claudeMd).not.toContain('## ORIENT');
    expect(claudeMd).toContain(renderMemoryProtocol('claude-code').trim());
  });

  test('keeps Claude L3 hooks opt-in by default', async () => {
    await runSetup('claude-code');

    // When claude CLI is unavailable, setup falls back to ~/.claude.json
    const configPath = join(tempHome, '.claude.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;

    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({ MIND_AGENT: 'claude-code' });
    expect(config.hooks).toBeUndefined();
  });

  test('keeps Claude setup non-destructive and managed block idempotent across runs', async () => {
    const claudeDir = join(tempHome, '.claude');
    const readPath = join(claudeDir, 'settings.json'); // where setup reads existing config
    const writePath = join(tempHome, '.claude.json'); // where setup writes fallback config
    const claudeMdPath = join(claudeDir, 'CLAUDE.md');

    const existingConfig = {
      theme: 'dark',
      mcpServers: {
        github: { url: 'http://localhost:9999/mcp' },
      },
    };

    const existingClaudeMd = [
      '# Custom Intro',
      '',
      'Keep this section untouched.',
      '',
      '<!-- mind managed protocol start -->',
      'outdated managed content',
      '<!-- mind managed protocol end -->',
      '',
      '## Footer',
    ].join('\n');

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(readPath, JSON.stringify(existingConfig, null, 2));
    writeFileSync(claudeMdPath, existingClaudeMd);

    await runSetup('claude-code');
    await runSetup('claude-code');

    // Config is read from settings.json, merged, and written to ~/.claude.json (fallback)
    const mergedConfig = JSON.parse(readFileSync(writePath, 'utf-8')) as Record<string, any>;
    expect(mergedConfig.theme).toBe('dark');
    expect(mergedConfig.mcpServers.github.url).toBe('http://localhost:9999/mcp');
    expect(mergedConfig.mcpServers.mind.type).toBe('stdio');
    expect(mergedConfig.mcpServers.mind.command).toEqual(expect.any(String));
    expect(mergedConfig.mcpServers.mind.args).toEqual(['mcp']);
    expect(mergedConfig.mcpServers.mind.env).toEqual({ MIND_AGENT: 'claude-code' });

    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd).toContain('# Custom Intro');
    expect(claudeMd).toContain('## Footer');

    const managedStartCount = claudeMd.split('<!-- mind managed protocol start -->').length - 1;
    const managedEndCount = claudeMd.split('<!-- mind managed protocol end -->').length - 1;
    expect(managedStartCount).toBe(1);
    expect(managedEndCount).toBe(1);
  });

  test('removes legacy url field from mind MCP config for stdio transport agents', async () => {
    // Test claude-code
    const claudeDir = join(tempHome, '.claude');
    const claudeSettingsPath = join(claudeDir, 'settings.json');
    const claudeFallbackPath = join(tempHome, '.claude.json');
    mkdirSync(claudeDir, { recursive: true });

    const existingClaudeConfig = {
      mcpServers: {
        mind: {
          url: 'http://localhost:7438/mcp', // OLD - should be removed
          command: ['/old/path/to/mind', 'mcp'],
          enabled: true,
        },
      },
    };
    writeFileSync(claudeSettingsPath, JSON.stringify(existingClaudeConfig, null, 2));

    await runSetup('claude-code');

    // Setup reads from settings.json, merges, and writes to ~/.claude.json (fallback)
    const claudeConfig = JSON.parse(readFileSync(claudeFallbackPath, 'utf-8')) as Record<
      string,
      any
    >;
    expect(claudeConfig.mcpServers.mind.url).toBeUndefined();
    expect(claudeConfig.mcpServers.mind.type).toBe('stdio');
    expect(claudeConfig.mcpServers.mind.command).toEqual(expect.any(String));
    expect(claudeConfig.mcpServers.mind.args).toEqual(['mcp']);
    expect(claudeConfig.mcpServers.mind.env).toEqual({ MIND_AGENT: 'claude-code' });

    // Test cursor
    const cursorDir = join(tempHome, '.cursor');
    const cursorMcpPath = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir, { recursive: true });

    const existingCursorConfig = {
      mcpServers: {
        mind: {
          url: 'http://localhost:7438/mcp', // OLD - should be removed
          command: ['/old/path/to/mind', 'mcp'],
          enabled: true,
        },
      },
    };
    writeFileSync(cursorMcpPath, JSON.stringify(existingCursorConfig, null, 2));

    await runSetup('cursor');

    const cursorConfig = JSON.parse(readFileSync(cursorMcpPath, 'utf-8')) as Record<string, any>;
    expect(cursorConfig.mcpServers.mind.url).toBeUndefined();
    expect(cursorConfig.mcpServers.mind.type).toBe('stdio');
    expect(cursorConfig.mcpServers.mind.command).toEqual(expect.any(String));
    expect(cursorConfig.mcpServers.mind.args).toEqual(['mcp']);
    expect(cursorConfig.mcpServers.mind.env).toEqual({ MIND_AGENT: 'cursor' });

    // Test windsurf
    const windsurfDir = join(tempHome, '.config', 'devin');
    const windsurfMcpPath = join(windsurfDir, 'mcp_config.json');
    mkdirSync(windsurfDir, { recursive: true });

    const existingWindsurfConfig = {
      mcpServers: {
        mind: {
          url: 'http://localhost:7438/mcp',
          command: ['/old/path/to/mind', 'mcp'],
          enabled: true,
        },
      },
    };
    writeFileSync(windsurfMcpPath, JSON.stringify(existingWindsurfConfig, null, 2));

    await runSetup('windsurf');

    const windsurfConfig = JSON.parse(readFileSync(windsurfMcpPath, 'utf-8')) as Record<
      string,
      any
    >;
    expect(windsurfConfig.mcpServers.mind.url).toBeUndefined();
    expect(windsurfConfig.mcpServers.mind.type).toBe('stdio');
    expect(windsurfConfig.mcpServers.mind.command).toEqual(expect.any(String));
    expect(windsurfConfig.mcpServers.mind.args).toEqual(['mcp']);
    expect(windsurfConfig.mcpServers.mind.env).toEqual({ MIND_AGENT: 'windsurf' });

    // Test gemini-cli
    const geminiDir = join(tempHome, '.gemini');
    const geminiSettingsPath = join(geminiDir, 'settings.json');
    mkdirSync(geminiDir, { recursive: true });

    const existingGeminiConfig = {
      mcpServers: {
        mind: {
          url: 'http://localhost:7438/mcp',
          command: ['/old/path/to/mind', 'mcp'],
          enabled: true,
        },
      },
    };
    writeFileSync(geminiSettingsPath, JSON.stringify(existingGeminiConfig, null, 2));

    await runSetup('gemini-cli');

    const geminiConfig = JSON.parse(readFileSync(geminiSettingsPath, 'utf-8')) as Record<
      string,
      any
    >;
    expect(geminiConfig.mcpServers.mind.url).toBeUndefined();
    expect(geminiConfig.mcpServers.mind.type).toBe('stdio');
    expect(geminiConfig.mcpServers.mind.command).toEqual(expect.any(String));
    expect(geminiConfig.mcpServers.mind.args).toEqual(['mcp']);
    expect(geminiConfig.mcpServers.mind.env).toEqual({ MIND_AGENT: 'gemini-cli' });
  });

  test('repairs dirty Claude managed blocks and removes legacy protocol files', async () => {
    const claudeDir = join(tempHome, '.claude');
    const claudeMdPath = join(claudeDir, 'CLAUDE.md');
    const legacyProtocolPath = join(claudeDir, 'instructions', 'mind-memory-protocol-claude.md');

    mkdirSync(join(claudeDir, 'instructions'), { recursive: true });
    writeFileSync(
      claudeMdPath,
      [
        '# Claude Notes',
        '',
        '<!-- mind managed protocol start -->',
        'old-1',
        '<!-- mind managed protocol end -->',
        '',
        '<!-- mind managed protocol start -->',
        'old-2',
        '<!-- mind managed protocol end -->',
      ].join('\n')
    );
    writeFileSync(legacyProtocolPath, '# stale claude protocol');

    await runSetup('claude-code');
    await runSetup('claude-code');

    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd.split('<!-- mind managed protocol start -->').length - 1).toBe(1);
    expect(claudeMd.split('<!-- mind managed protocol end -->').length - 1).toBe(1);
    expect(existsSync(legacyProtocolPath)).toBe(false);
  });

  test('keeps Claude hook wiring stable and idempotent when opt-in is enabled', async () => {
    process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS = 'true';
    await runSetup('claude-code');
    await runSetup('claude-code');

    // When claude CLI is unavailable, setup falls back to ~/.claude.json
    const settingsPath = join(tempHome, '.claude.json');
    const config = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
    const stopHooks = config.hooks?.Stop as Array<Record<string, any>>;
    expect(Array.isArray(stopHooks)).toBe(true);

    const hookPath = join(tempHome, '.claude', 'hooks', 'mind-session-summary.sh');
    const managedEntries = stopHooks.filter(entry =>
      Array.isArray(entry?.hooks)
        ? entry.hooks.some((hook: Record<string, any>) => hook.command === hookPath)
        : false
    );
    expect(managedEntries.length).toBe(1);

    const hookScript = readFileSync(hookPath, 'utf-8');
    expect(hookScript).toContain('mind checkpoint set');
    expect(hookScript).toContain('|| true');
  });

  test('deduplicates dirty Claude hook entries when opt-in is enabled', async () => {
    process.env.MIND_SETUP_CLAUDE_ENABLE_HOOKS = 'true';
    const claudeDir = join(tempHome, '.claude');
    const settingsPath = join(tempHome, '.claude.json'); // fallback path when CLI unavailable
    const hookPath = join(tempHome, '.claude', 'hooks', 'mind-session-summary.sh');

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: 'session.stop',
                hooks: [
                  { type: 'command', command: hookPath },
                  { type: 'command', command: hookPath },
                ],
              },
              {
                matcher: 'session.stop',
                hooks: [{ type: 'command', command: hookPath }],
              },
            ],
          },
        },
        null,
        2
      )
    );

    await runSetup('claude-code');
    await runSetup('claude-code');

    const config = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
    const stopHooks = config.hooks?.Stop as Array<Record<string, any>>;
    const managedEntries = stopHooks.filter(entry =>
      Array.isArray(entry?.hooks)
        ? entry.hooks.some((hook: Record<string, any>) => hook.command === hookPath)
        : false
    );

    expect(managedEntries.length).toBe(1);
  });

  test('claude CLI not available - falls back to ~/.claude.json with warning', async () => {
    const warnSpy = spyOn(console, 'warn');

    await runSetup('claude-code');

    // Should write to ~/.claude.json (fallback) since claude CLI is not available
    const fallbackPath = join(tempHome, '.claude.json');
    expect(existsSync(fallbackPath)).toBe(true);

    const config = JSON.parse(readFileSync(fallbackPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({ MIND_AGENT: 'claude-code' });

    // Warning about CLI not found
    expect(warnSpy.mock.calls.some(call => String(call[0]).includes('claude CLI not found'))).toBe(
      true
    );

    // L2/L3 still ran
    const instructionsPath = join(tempHome, '.claude', 'instructions', 'mind-memory-protocol.md');
    expect(existsSync(instructionsPath)).toBe(true);
  });

  test('claude-code setup L2/L3 artifacts created even when CLI fallback is used', async () => {
    await runSetup('claude-code');

    // L2: instructions file created
    const instructionsPath = join(tempHome, '.claude', 'instructions', 'mind-memory-protocol.md');
    expect(existsSync(instructionsPath)).toBe(true);

    // L2: CLAUDE.md managed block created
    const claudeMdPath = join(tempHome, '.claude', 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd).toContain('mind managed protocol start');
    expect(claudeMd).toContain('mind managed protocol end');

    // Fallback config file written
    const fallbackPath = join(tempHome, '.claude.json');
    expect(existsSync(fallbackPath)).toBe(true);
  });

  test('refresh default updates detected OpenCode managed artifacts without creating unrelated agent configs', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const configPath = join(opencodeDir, 'opencode.json');

    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          theme: 'dark',
          mcp: {
            mind: {
              type: 'local',
              command: ['/stale/mind', 'mcp'],
              enabled: true,
            },
          },
        },
        null,
        2
      )
    );

    const result = await runSetupRefresh({ mode: 'detected' });

    expect(result.refreshedAgents).toEqual(['opencode']);
    const refreshed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(refreshed.theme).toBe('dark');
    expect(refreshed.mcp.mind.command).toEqual([join(import.meta.dir, '..', 'mind'), 'mcp']);
    expect(
      existsSync(join(tempHome, '.config', 'opencode', 'instructions', 'mind-memory-protocol.md'))
    ).toBe(true);
    expect(existsSync(join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js'))).toBe(
      true
    );
    expect(existsSync(join(tempHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.gemini', 'settings.json'))).toBe(false);
  });

  test('detects shared clients from the canonical skill only when their config exists', () => {
    installMindManagementSkill('codex');

    expect(isAgentIntegrationDetected('codex')).toBe(false);

    mkdirSync(join(tempHome, '.config', 'opencode'), { recursive: true });
    expect(isAgentIntegrationDetected('opencode')).toBe(true);
  });

  test('detects a dedicated client from its skill symlink', () => {
    installMindManagementSkill('claude-code');

    expect(isAgentIntegrationDetected('claude-code')).toBe(true);
  });

  test('refresh default skips agents with no mind-owned signal', async () => {
    const result = await runSetupRefresh({ mode: 'detected' });

    expect(result.refreshedAgents).toEqual([]);
    expect(existsSync(join(tempHome, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.claude.json'))).toBe(false);
  });

  test('refresh repairs existing Claude hook artifacts without requiring opt-in env', async () => {
    const claudeDir = join(tempHome, '.claude');
    const settingsPath = join(tempHome, '.claude.json');
    const hookPath = join(claudeDir, 'hooks', 'mind-session-summary.sh');

    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/usr/bin/env bash\necho stale\n');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          mcpServers: { mind: { command: '/stale/mind', args: ['mcp'] } },
        },
        null,
        2
      )
    );

    const result = await runSetupRefresh({ mode: 'detected' });

    expect(result.refreshedAgents).toEqual(['claude-code']);
    const refreshed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, any>;
    const stopHooks = refreshed.hooks?.Stop as Array<Record<string, any>>;
    expect(Array.isArray(stopHooks)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('mind checkpoint set');
  });
});

describe('Setup safety: parse failure and atomic writes (cross-agent)', () => {
  test('aborts and does not overwrite a malformed Claude settings.json', async () => {
    const claudeDir = join(tempHome, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    mkdirSync(claudeDir, { recursive: true });
    const original = '{ "theme": "dark", "mcpServers": '; // truncated
    writeFileSync(settingsPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('claude-code');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message ?? '')).toMatch(/malformed|setup/i);

    // Original file is unchanged. (May have been moved/renamed in fallback,
    // but the content we wrote to settings.json stays.)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  test('backs up Cursor mcp.json before mutating it', async () => {
    const cursorDir = join(tempHome, '.cursor');
    const mcpPath = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir, { recursive: true });
    const original = { mcpServers: { github: { command: 'gh' } } };
    writeFileSync(mcpPath, JSON.stringify(original, null, 2));

    await runSetup('cursor');

    const entries = readdirSync(cursorDir).filter(name => name.startsWith('mcp.json.bak.'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const backup = JSON.parse(
      readFileSync(join(cursorDir, entries[0] as string), 'utf-8')
    ) as Record<string, any>;
    expect(backup.mcpServers.github.command).toBe('gh');
  });

  test('aborts and does not overwrite a malformed Windsurf mcp_config.json', async () => {
    const windsurfDir = join(tempHome, '.config', 'devin');
    const mcpPath = join(windsurfDir, 'mcp_config.json');
    mkdirSync(windsurfDir, { recursive: true });
    const original = '{ "mcpServers": '; // truncated
    writeFileSync(mcpPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('windsurf');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(readFileSync(mcpPath, 'utf-8')).toBe(original);
  });

  test('aborts and does not overwrite a malformed Gemini settings.json', async () => {
    const geminiDir = join(tempHome, '.gemini');
    const settingsPath = join(geminiDir, 'settings.json');
    mkdirSync(geminiDir, { recursive: true });
    const original = '{ "mcpServers": '; // truncated
    writeFileSync(settingsPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('gemini-cli');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  test('aborts and does not overwrite a malformed VSCode mcp-config.json', async () => {
    const vscodeDir = join(tempHome, '.copilot');
    const mcpPath = join(vscodeDir, 'mcp-config.json');
    mkdirSync(vscodeDir, { recursive: true });
    const original = '{ "mcpServers": '; // truncated
    writeFileSync(mcpPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('vscode');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(readFileSync(mcpPath, 'utf-8')).toBe(original);
  });

  test('aborts and does not overwrite a malformed Antigravity mcp_config.json', async () => {
    const antigravityDir = join(tempHome, '.gemini', 'config');
    const mcpPath = join(antigravityDir, 'mcp_config.json');
    mkdirSync(antigravityDir, { recursive: true });
    const original = '{ "mcpServers": '; // truncated
    writeFileSync(mcpPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('antigravity');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(readFileSync(mcpPath, 'utf-8')).toBe(original);
  });

  test('refresh path also uses safe writes and backs up files', async () => {
    const cursorDir = join(tempHome, '.cursor');
    const mcpPath = join(cursorDir, 'mcp.json');
    mkdirSync(cursorDir, { recursive: true });
    const original = { mcpServers: { mind: { command: '/stale/mind', args: ['mcp'] } } };
    writeFileSync(mcpPath, JSON.stringify(original, null, 2));

    // Mark as detected so refresh picks it up.
    const result = await runSetupRefresh({ mode: 'detected' });
    expect(result.refreshedAgents).toContain('cursor');

    const entries = readdirSync(cursorDir).filter(name => name.startsWith('mcp.json.bak.'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const backup = JSON.parse(
      readFileSync(join(cursorDir, entries[0] as string), 'utf-8')
    ) as Record<string, any>;
    expect(backup.mcpServers.mind.command).toBe('/stale/mind');
  });
});

describe('Codex TOML write path safety', () => {
  test('creates a brand-new config.toml when none exists (no backup)', async () => {
    await runSetup('codex');

    const configPath = join(tempHome, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('[mcp_servers.mind]');
    expect(text).toContain('args = ["mcp"]');

    // No backup sibling for a previously-missing target.
    const codexDir = join(tempHome, '.codex');
    const entries = readdirSync(codexDir).filter(n => n.startsWith('config.toml.bak.'));
    expect(entries).toEqual([]);
  });

  test('appends the mind stanza when an existing config has no mind stanza, preserving unrelated content', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });

    const original = ['# pre-existing user config', '[user_settings]', 'theme = "dark"', ''].join(
      '\n'
    );
    writeFileSync(configPath, original);

    await runSetup('codex');

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# pre-existing user config');
    expect(after).toContain('[user_settings]');
    expect(after).toContain('theme = "dark"');
    expect(after).toContain('[mcp_servers.mind]');
    expect(after).toContain('args = ["mcp"]');

    // Stanza count is exactly one (no duplicates from a second run).
    const stanzaCount = after.split('[mcp_servers.mind]').length - 1;
    expect(stanzaCount).toBe(1);

    // Backup created with pre-write content.
    const entries = readdirSync(codexDir).filter(n => n.startsWith('config.toml.bak.'));
    expect(entries.length).toBe(1);
    expect(readFileSync(join(codexDir, entries[0] as string), 'utf-8')).toBe(original);
  });

  test('replaces a stale mind stanza with the new one, preserving unrelated content', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });

    const original = [
      '# pre-existing user config',
      '[user_settings]',
      'theme = "dark"',
      '',
      '[mcp_servers.mind]',
      'command = "/stale/path/to/mind"',
      'args = ["mcp", "--http"]',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    await runSetup('codex');

    const after = readFileSync(configPath, 'utf-8');
    // Unrelated user content is preserved.
    expect(after).toContain('# pre-existing user config');
    expect(after).toContain('[user_settings]');
    expect(after).toContain('theme = "dark"');
    // Stale command/args are gone.
    expect(after).not.toContain('/stale/path/to/mind');
    expect(after).not.toContain('--http');
    // The new stanza is present exactly once.
    const stanzaCount = after.split('[mcp_servers.mind]').length - 1;
    expect(stanzaCount).toBe(1);
    expect(after).toContain('args = ["mcp"]');
  });

  test('is a no-op on a re-run when the file already has the freshly-built stanza', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });

    // First run creates the file with the actual snippet the codex write
    // path produces for THIS mind script path. The second run must not
    // mutate the file at all (idempotent) and must not create a backup
    // sibling (no content-changing write occurred).
    await runSetup('codex');
    const first = readFileSync(configPath, 'utf-8');
    const beforeBackups = readdirSync(codexDir).filter(n =>
      n.startsWith('config.toml.bak.')
    ).length;

    await runSetup('codex');
    const second = readFileSync(configPath, 'utf-8');

    expect(second).toBe(first);
    const afterBackups = readdirSync(codexDir).filter(n => n.startsWith('config.toml.bak.')).length;
    expect(afterBackups).toBe(beforeBackups);

    const stanzaCount = second.split('[mcp_servers.mind]').length - 1;
    expect(stanzaCount).toBe(1);
  });

  test('aborts and does not overwrite a malformed config.toml', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    const original = '[mcp_servers.mind]\ncommand = "unterminated string\n';
    writeFileSync(configPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('codex');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message ?? '')).toMatch(/malformed|toml|setup/i);

    // Original file is unchanged.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    // No backup created (we never reached the write step).
    const entries = readdirSync(codexDir).filter(n => n.startsWith('config.toml.bak.'));
    expect(entries).toEqual([]);
  });

  test('detects an existing codex integration from a TOML config with the mind stanza', async () => {
    const { isAgentIntegrationDetected } = await import('../src/cli/setup');
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      '[mcp_servers.mind]\ncommand = "/usr/local/bin/mind"\nargs = ["mcp"]\n'
    );

    expect(isAgentIntegrationDetected('codex')).toBe(true);
  });

  test('does not detect a codex integration when only JSON-shaped mind keys are present', async () => {
    // Regression guard: the detection path used to read the TOML file as
    // JSON. A TOML stanza does NOT parse as JSON, and a JSON-shaped
    // snippet does NOT parse as TOML. The detector must use the
    // format-appropriate parser, not the JSON probe.
    const { isAgentIntegrationDetected } = await import('../src/cli/setup');
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(configPath, '# TOML file with no mind stanza\n[other]\nkey = "value"\n');

    expect(isAgentIntegrationDetected('codex')).toBe(false);
  });
});

describe('Setup MIND_AGENT attribution', () => {
  const IDENTITY_BY_AGENT = [
    ['opencode', 'opencode'],
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['cursor', 'cursor'],
    ['windsurf', 'windsurf'],
    ['gemini-cli', 'gemini-cli'],
    ['vscode', 'vscode'],
    ['antigravity', 'antigravity'],
    ['pi', 'pi'],
  ] as const;

  function readMindEntry(agent: string): Record<string, any> {
    const home = tempHome;

    switch (agent) {
      case 'opencode': {
        const config = JSON.parse(
          readFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf-8')
        ) as Record<string, any>;
        return config.mcp.mind as Record<string, any>;
      }
      case 'claude-code': {
        const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as Record<
          string,
          any
        >;
        return config.mcpServers.mind as Record<string, any>;
      }
      case 'codex': {
        const config = readTomlOrThrow(join(home, '.codex', 'config.toml'));
        return (config.mcp_servers as Record<string, any>).mind as Record<string, any>;
      }
      case 'cursor':
        return JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf-8')).mcpServers
          .mind as Record<string, any>;
      case 'windsurf':
        return JSON.parse(readFileSync(join(home, '.config', 'devin', 'mcp_config.json'), 'utf-8'))
          .mcpServers.mind as Record<string, any>;
      case 'gemini-cli':
        return JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf-8')).mcpServers
          .mind as Record<string, any>;
      case 'vscode':
        return JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf-8'))
          .mcpServers.mind as Record<string, any>;
      case 'antigravity':
        return JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf-8'))
          .mcpServers.mind as Record<string, any>;
      case 'pi':
        return JSON.parse(readFileSync(join(home, '.pi', 'agent', 'mcp.json'), 'utf-8')).mcpServers
          .mind as Record<string, any>;
      default:
        throw new Error(`Unknown agent: ${agent}`);
    }
  }

  for (const [agent, identity] of IDENTITY_BY_AGENT) {
    test(`writes MIND_AGENT=${identity} for ${agent}`, async () => {
      await runSetup(agent);

      const entry = readMindEntry(agent);
      const environment = (agent === 'opencode' ? entry.environment : entry.env) as Record<
        string,
        string
      >;

      expect(environment.MIND_AGENT).toBe(identity);
      if (agent === 'opencode') {
        expect(entry.command[1]).toBe('mcp');
      } else {
        expect(entry.args).toEqual(['mcp']);
      }
    });
  }

  test('preserves an existing custom env entry for JSON agents', async () => {
    const cursorDir = join(tempHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            mind: {
              type: 'stdio',
              command: '/old/mind',
              args: ['mcp'],
              env: { CUSTOM: 'keep' },
            },
          },
        },
        null,
        2
      )
    );

    await runSetup('cursor');
    await runSetup('cursor');

    const config = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8')) as Record<
      string,
      any
    >;
    expect(config.mcpServers.mind.env).toEqual({ CUSTOM: 'keep', MIND_AGENT: 'cursor' });
  });

  test('preserves an existing OpenCode environment entry and uses the environment key', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      join(opencodeDir, 'opencode.jsonc'),
      JSON.stringify({ mcp: { mind: { environment: { CUSTOM: 'keep' } } } }, null, 2)
    );

    await runSetup('opencode');
    await runSetup('opencode');

    const config = JSON.parse(readFileSync(join(opencodeDir, 'opencode.jsonc'), 'utf-8')) as Record<
      string,
      any
    >;
    expect(config.mcp.mind.environment).toEqual({ CUSTOM: 'keep', MIND_AGENT: 'opencode' });
    expect(config.mcp.mind.env).toBeUndefined();
  });

  test('preserves custom Codex stanza env keys and overwrites MIND_AGENT', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        '# pre-existing user config',
        '[user_settings]',
        'theme = "dark"',
        '',
        '[mcp_servers.mind]',
        'command = "/stale/path/to/mind"',
        'args = ["mcp", "--http"]',
        'env = { CUSTOM = "keep", MIND_AGENT = "stale" }',
        '',
      ].join('\n')
    );

    await runSetup('codex');

    const config = readTomlOrThrow(configPath);
    const mind = (config.mcp_servers as Record<string, any>).mind as Record<string, any>;
    expect(mind.args).toEqual(['mcp']);
    expect(mind.env).toEqual({ CUSTOM: 'keep', MIND_AGENT: 'codex' });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# pre-existing user config');
    expect(after).toContain('theme = "dark"');
    expect(after.split('[mcp_servers.mind]').length - 1).toBe(1);
  });

  test('folds a legacy Codex env subtable into the stanza without duplicating it', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        '[mcp_servers.mind]',
        'command = "/stale/path/to/mind"',
        'args = ["mcp"]',
        '',
        '[mcp_servers.mind.env]',
        'CUSTOM = "keep"',
        '',
        '[user_settings]',
        'theme = "dark"',
        '',
      ].join('\n')
    );

    await runSetup('codex');

    const config = readTomlOrThrow(configPath);
    const mind = (config.mcp_servers as Record<string, any>).mind as Record<string, any>;
    expect(mind.env).toEqual({ CUSTOM: 'keep', MIND_AGENT: 'codex' });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain('[mcp_servers.mind.env]');
    expect(after).toContain('[user_settings]');
  });

  test('is idempotent for Codex when a custom env key is present', async () => {
    const codexDir = join(tempHome, '.codex');
    const configPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        '[mcp_servers.mind]',
        'command = "/stale/path/to/mind"',
        'args = ["mcp"]',
        'env = { CUSTOM = "keep" }',
        '',
      ].join('\n')
    );

    await runSetup('codex');
    const first = readFileSync(configPath, 'utf-8');
    const beforeBackups = readdirSync(codexDir).filter(n =>
      n.startsWith('config.toml.bak.')
    ).length;

    await runSetup('codex');
    const second = readFileSync(configPath, 'utf-8');

    expect(second).toBe(first);
    const afterBackups = readdirSync(codexDir).filter(n => n.startsWith('config.toml.bak.')).length;
    expect(afterBackups).toBe(beforeBackups);
  });

  test('builds Claude mcp add argv with exactly one MIND_AGENT env flag', () => {
    const args = buildClaudeMcpAddArgs('/opt/mind');

    expect(args.filter(arg => arg === '--env')).toHaveLength(1);
    expect(args.filter(arg => arg === 'MIND_AGENT=claude-code')).toHaveLength(1);
    expect(args).toEqual([
      'mcp',
      'add',
      '--transport',
      'stdio',
      '--scope',
      'user',
      'mind',
      '--env',
      'MIND_AGENT=claude-code',
      '--',
      '/opt/mind',
      'mcp',
    ]);
  });
});
