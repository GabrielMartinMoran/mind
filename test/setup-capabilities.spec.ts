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

import { renderMemoryProtocol } from '../src/cli/memory-protocol';
import {
  getAgentCapabilityMatrix,
  getAgentCapabilities,
  listAgents,
  runSetup,
  runSetupRefresh,
} from '../src/cli/setup';

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
    expect(cursor.L3_HOOKS.status).toBe('supported');

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

  test('setup command output exposes capability statuses and evidence notes', () => {
    const logSpy = spyOn(console, 'log');

    listAgents();

    const lines = logSpy.mock.calls.map(call => String(call[0]));
    // New format uses 🧠 Available Agents header and compact badge format
    expect(lines.some(line => line.includes('🧠 Available Agents'))).toBe(true);
    expect(lines.some(line => line.includes('Cursor'))).toBe(true);
    // Capability badges show ⚠️ for unverified status
    expect(lines.some(line => line.includes('⚠️'))).toBe(true);
  });

  test('keeps Cursor L1 setup behavior while configuring managed global hooks artifacts', async () => {
    await runSetup('cursor');
    await runSetup('cursor');

    const configPath = join(tempHome, '.cursor', 'mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({});

    const hooksPath = join(tempHome, '.cursor', 'hooks.json');
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    expect(Array.isArray(hooks.sessionStart)).toBe(true);
    expect(Array.isArray(hooks.preCompact)).toBe(true);
    expect(Array.isArray(hooks.stop)).toBe(true);

    const hookScriptPath = join(tempHome, '.cursor', 'hooks', 'mind-session-continuity.sh');
    const hookScript = readFileSync(hookScriptPath, 'utf-8');
    expect(hookScript).toContain('mind checkpoint set');
    expect(hookScript).not.toContain('--history');

    const startMatches = (hooks.sessionStart as Array<Record<string, any>>).filter(
      entry => entry?.command === hookScriptPath
    );
    const preCompactMatches = (hooks.preCompact as Array<Record<string, any>>).filter(
      entry => entry?.command === hookScriptPath
    );
    const stopMatches = (hooks.stop as Array<Record<string, any>>).filter(
      entry => entry?.command === hookScriptPath
    );

    expect(startMatches.length).toBe(1);
    expect(preCompactMatches.length).toBe(1);
    expect(stopMatches.length).toBe(1);
  });

  test('keeps Cursor hooks setup non-destructive for existing hooks entries', async () => {
    const cursorDir = join(tempHome, '.cursor');
    const hooksPath = join(cursorDir, 'hooks.json');

    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          sessionStart: [{ command: '/custom/start.sh' }],
          customEvent: [{ command: '/custom/other.sh' }],
        },
        null,
        2
      )
    );

    await runSetup('cursor');

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    expect(hooks.customEvent).toEqual([{ command: '/custom/other.sh' }]);
    expect(
      (hooks.sessionStart as Array<Record<string, any>>).some(
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
          sessionStart: [
            { command: hookScriptPath, args: ['sessionStart'] },
            { command: hookScriptPath, args: ['sessionStart'] },
          ],
          preCompact: [{ command: hookScriptPath, args: ['preCompact'] }],
          stop: [
            { command: hookScriptPath, args: ['stop'] },
            { command: hookScriptPath, args: ['stop'] },
          ],
        },
        null,
        2
      )
    );

    await runSetup('cursor');
    await runSetup('cursor');

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as Record<string, any>;
    expect(
      (hooks.sessionStart as Array<Record<string, any>>).filter(
        entry => entry.command === hookScriptPath && entry.args?.[0] === 'sessionStart'
      ).length
    ).toBe(1);
    expect(
      (hooks.preCompact as Array<Record<string, any>>).filter(
        entry => entry.command === hookScriptPath && entry.args?.[0] === 'preCompact'
      ).length
    ).toBe(1);
    expect(
      (hooks.stop as Array<Record<string, any>>).filter(
        entry => entry.command === hookScriptPath && entry.args?.[0] === 'stop'
      ).length
    ).toBe(1);
  });

  test('keeps Windsurf L1 setup behavior while leaving L2/L3 unsupported', async () => {
    await runSetup('windsurf');

    const configPath = join(tempHome, '.windsurf', 'mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
    expect(config.mcpServers.mind.type).toBe('stdio');
    expect(config.mcpServers.mind.command).toEqual(expect.any(String));
    expect(config.mcpServers.mind.args).toEqual(['mcp']);
    expect(config.mcpServers.mind.env).toEqual({});

    const capabilities = getAgentCapabilities('windsurf');
    expect(capabilities.L2_INSTRUCTIONS.status).toBe('unsupported');
    expect(capabilities.L3_HOOKS.status).toBe('unsupported');
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
    expect(agentsMd).toContain('## ORIENT');
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
    expect(claudeMd).toContain('## ORIENT');
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
    expect(config.mcpServers.mind.env).toEqual({});
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
    expect(mergedConfig.mcpServers.mind.env).toEqual({});

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
    expect(claudeConfig.mcpServers.mind.env).toEqual({});

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
    expect(cursorConfig.mcpServers.mind.env).toEqual({});

    // Test windsurf
    const windsurfDir = join(tempHome, '.windsurf');
    const windsurfMcpPath = join(windsurfDir, 'mcp.json');
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
    expect(windsurfConfig.mcpServers.mind.env).toEqual({});

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
    expect(geminiConfig.mcpServers.mind.env).toEqual({});
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
    expect(config.mcpServers.mind.env).toEqual({});

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

  test('aborts and does not overwrite a malformed Windsurf mcp.json', async () => {
    const windsurfDir = join(tempHome, '.windsurf');
    const mcpPath = join(windsurfDir, 'mcp.json');
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

  test('aborts and does not overwrite a malformed VSCode mcp.json', async () => {
    const vscodeDir = join(tempHome, '.config', 'Code', 'User');
    const mcpPath = join(vscodeDir, 'mcp.json');
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
    const antigravityDir = join(tempHome, '.gemini', 'antigravity');
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
