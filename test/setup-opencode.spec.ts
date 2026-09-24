import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { renderMemoryProtocol } from '../src/cli/memory-protocol';
import { buildOpenCodeAutomationPlugin, runSetup } from '../src/cli/setup';

function stripJsoncComments(text: string): string {
  // Strip /* block */ and // line comments. Naive but adequate for
  // opencode.jsonc fixtures in these tests.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

let previousHome = '';
let tempHome = '';

beforeEach(() => {
  previousHome = process.env.HOME ?? '';
  tempHome = mkdtempSync(join(tmpdir(), 'mind-opencode-setup-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = previousHome;
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('OpenCode setup integration', () => {
  test('is non-destructive and injects memory protocol instructions', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const configPath = join(opencodeDir, 'opencode.jsonc');

    const existing = {
      theme: 'dark',
      mcp: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
      instructions: ['AGENTS.md'],
      customKey: { keep: true },
    };

    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(configPath, '// opencode config\n' + JSON.stringify(existing, null, 2) + '\n');

    await runSetup('opencode');

    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('// opencode config'); // JSONC comment preserved
    const parsed = JSON.parse(stripJsoncComments(text)) as Record<string, any>;

    expect(parsed.theme).toBe('dark');
    expect(parsed.customKey.keep).toBe(true);
    expect(parsed.mcp.github.command).toBe('npx');
    const expectedMindPath = join(import.meta.dir, '..', 'mind');
    expect(parsed.mcp.mind.type).toBe('local');
    expect(parsed.mcp.mind.command).toEqual([expectedMindPath, 'mcp']);
    expect(parsed.mcp.mind.enabled).toBe(true);

    expect(Array.isArray(parsed.instructions)).toBe(true);
    expect(parsed.instructions).toContain('AGENTS.md');

    const expectedInstructionPath = join(
      tempHome,
      '.config',
      'opencode',
      'instructions',
      'mind-memory-protocol.md'
    );
    expect(parsed.instructions[0]).toBe(expectedInstructionPath);

    const injectedPath = parsed.instructions.find(
      (item: string) => item === expectedInstructionPath
    );
    expect(injectedPath).toBeDefined();
    expect(existsSync(injectedPath)).toBe(true);

    const injectedText = readFileSync(injectedPath, 'utf-8');
    expect(injectedText).toBe(renderMemoryProtocol('opencode'));
    expect(injectedText).toContain('Mind Memory Protocol');
    expect(injectedText).toContain('Post-Compaction');
    expect(injectedText).toContain('system_instructions');
  });

  test('is idempotent for repeated setup runs', async () => {
    await runSetup('opencode');
    await runSetup('opencode');

    const configPath = join(tempHome, '.config', 'opencode', 'opencode.jsonc');
    const text = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(stripJsoncComments(text)) as Record<string, any>;

    const mindEntries = Object.keys(parsed.mcp).filter(k => k === 'mind');
    expect(mindEntries.length).toBe(1);

    const expectedInstructionPath = join(
      tempHome,
      '.config',
      'opencode',
      'instructions',
      'mind-memory-protocol.md'
    );
    const instructionEntries = (parsed.instructions as string[]).filter(
      item => item === expectedInstructionPath
    );
    expect(instructionEntries.length).toBe(1);
    expect(parsed.instructions[0]).toBe(expectedInstructionPath);
  });

  test('normalizes dirty instruction list across multiple reruns', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const instructionsDir = join(opencodeDir, 'instructions');
    const configPath = join(opencodeDir, 'opencode.jsonc');
    const expectedInstructionPath = join(instructionsDir, 'mind-memory-protocol.md');
    const legacyPath = join(instructionsDir, 'mind-memory-protocol-opencode.md');

    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(legacyPath, '# legacy protocol should be removed\n');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          instructions: [
            'AGENTS.md',
            legacyPath,
            expectedInstructionPath,
            legacyPath,
            expectedInstructionPath,
          ],
        },
        null,
        2
      )
    );

    await runSetup('opencode');
    await runSetup('opencode');
    await runSetup('opencode');

    const text = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(stripJsoncComments(text)) as Record<string, any>;
    const entries = parsed.instructions as string[];

    expect(entries[0]).toBe(expectedInstructionPath);
    expect(entries.filter(item => item === expectedInstructionPath).length).toBe(1);
    expect(entries).not.toContain(legacyPath);
    expect(existsSync(legacyPath)).toBe(false);
  });

  test('writes OpenCode prudent automation plugin by default', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    expect(existsSync(pluginPath)).toBe(true);
  });

  test('writes OpenCode prudent automation plugin with required handlers', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    expect(existsSync(pluginPath)).toBe(true);

    const pluginText = readFileSync(pluginPath, 'utf-8');
    expect(pluginText).toContain('session.created');
    expect(pluginText).toContain('session.compacted');
    expect(pluginText).toContain('experimental.session.compacting');
    expect(pluginText).toContain('checkpoint set');
    expect(pluginText).toContain('checkpoint recover');
    expect(pluginText).not.toContain('--history');
    expect(pluginText).toContain('--name <checkpoint-name>');
    expect(pluginText).not.toContain('sessions/');
    expect(pluginText).toContain('type:session,cat:summary');
    expect(pluginText).toContain('--tier');
    expect(pluginText).toContain("'3'");
    expect(pluginText).toContain('mind.session-summary/v1');
    expect(pluginText).toContain('sessionSummary');
    expect(pluginText).toContain('writer');
    expect(pluginText).toContain('provenance');
    expect(pluginText).toContain('session.deleted');
    expect(pluginText).not.toContain('session.idle');
  });

  test('plugin exports experimental.chat.system.transform handler', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // Handler must be registered in the plugin
    expect(pluginText).toContain('experimental.chat.system.transform');
  });

  test('plugin contains RECOVERY_TEXT constant (~200 chars)', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // RECOVERY_TEXT constant must exist
    expect(pluginText).toContain('RECOVERY_TEXT');

    // Extract the RECOVERY_TEXT value - should be around 200 chars
    const match = pluginText.match(/RECOVERY_TEXT\s*=\s*[`'"]/);
    expect(match).not.toBeNull();

    // Find the actual text between the quotes
    const recoveryTextMatch = pluginText.match(/RECOVERY_TEXT\s*=\s*[`']([^`'"]+)[`'"]/);
    if (recoveryTextMatch && recoveryTextMatch[1]) {
      const recoveryText = recoveryTextMatch[1];
      expect(recoveryText.length).toBeGreaterThanOrEqual(150);
      expect(recoveryText.length).toBeLessThanOrEqual(250);
    }
  });

  test('chat.system.transform handler appends to LAST system entry (not push new)', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // The handler must modify the LAST entry, not push a new one
    // Look for pattern like: output.system[output.system.length - 1] += ... or output.system[lastIdx] += ...
    // where lastIdx is assigned output.system.length - 1
    expect(pluginText).toMatch(/output\.system\[(.*\.length\s*-\s*1|lastIdx)\]\s*\+=/);
  });

  test('chat.system.transform uses static reminder without subprocess for new sessions', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // For new sessions, should use RECOVERY_TEXT static reminder
    // and should NOT spawn a subprocess for the static reminder path
    // The handler should check session state and only spawn for active sessions
    expect(pluginText).toContain('RECOVERY_TEXT');
    // Should have logic to detect new vs active session
    expect(pluginText).toMatch(/sessionId|isActive|isNew/);
  });

  test('chat.system.transform is idempotent within same session', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // Must have state tracking to prevent duplicate reminders
    // Look for handled or similar dedupe mechanism
    expect(pluginText).toContain('handled');
  });

  test('chat.system.transform handles empty output.system gracefully', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // Should check if output.system exists and has entries before modifying
    // Look for guard conditions like: if (!output?.system?.length) return;
    expect(pluginText).toMatch(/output\.system.*length|if\s*\(\s*!.*output\.system/);
  });

  test('chat.system.transform handler is non-blocking (try/catch)', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    // Handler must be wrapped in try/catch to avoid crashing OpenCode
    // Find the experimental.chat.system.transform section and verify try/catch
    const handlerStart = pluginText.indexOf("'experimental.chat.system.transform'");
    if (handlerStart !== -1) {
      // Get a chunk after the handler registration
      const chunk = pluginText.slice(handlerStart, handlerStart + 2000);
      expect(chunk).toContain('try');
      expect(chunk).toContain('catch');
    }
  });

  test('generated plugin has valid JavaScript syntax', async () => {
    const mindBinPath = join(import.meta.dir, '..', '..', 'mind');
    const pluginContent = buildOpenCodeAutomationPlugin(mindBinPath);

    // Write to temp file for Bun.build
    const tmpPath = join(tmpdir(), `mind-automation-test-${Date.now()}.js`);
    await Bun.write(tmpPath, pluginContent);

    try {
      // Validate syntax without executing
      const result = await Bun.build({
        entrypoints: [tmpPath],
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        console.error('Plugin syntax errors:', result.logs);
      }
      expect(result.logs.length).toBe(0);
    } finally {
      // Cleanup
      await Bun.file(tmpPath).delete();
    }
  });

  test('plugin syntax validation catches embedded newline errors', async () => {
    // Corrupted plugin with literal newline in regex (the actual bug pattern)
    const corruptedPlugin = `
export const handlers = {
  test: () => {
    const x = 'hello'.replace(/
/g, '');
  }
};
`;

    const tmpPath = join(tmpdir(), `mind-automation-corrupt-${Date.now()}.js`);
    await Bun.write(tmpPath, corruptedPlugin);

    try {
      let buildFailed = false;
      try {
        const result = await Bun.build({
          entrypoints: [tmpPath],
        });
        buildFailed = !result.success;
      } catch {
        // Bun.build throws "Bundle failed" on syntax errors
        buildFailed = true;
      }

      expect(buildFailed).toBe(true);
    } finally {
      await Bun.file(tmpPath).delete();
    }
  });

  test('prefers opencode.jsonc over opencode.json when both exist', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsonPath = join(opencodeDir, 'opencode.json');
    const jsoncPath = join(opencodeDir, 'opencode.jsonc');

    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      jsonPath,
      JSON.stringify({ theme: 'dark', mcp: { github: { command: 'gh-mcp' } } }, null, 2)
    );
    writeFileSync(
      jsoncPath,
      [
        '// jsonc config with comments',
        '{',
        '  "theme": "light", // jsonc preferred',
        '  "mcp": { "github": { "command": "gh-mcp" } }',
        '}',
        '',
      ].join('\n')
    );

    await runSetup('opencode');

    // opencode.jsonc was the file chosen and updated. Comments may be
    // regenerated because the key set changed (mind + instructions added);
    // the contract is that the file is parseable and contains the merged
    // mind config.
    const jsoncText = readFileSync(jsoncPath, 'utf-8');
    expect(jsoncText).toContain('"mind"');
    expect(jsoncText).toContain('"github"');
    const jsoncParsed = JSON.parse(stripJsoncComments(jsoncText)) as Record<string, any>;
    expect(jsoncParsed.theme).toBe('light');
    expect(jsoncParsed.mcp.github.command).toBe('gh-mcp');
    expect(jsoncParsed.mcp.mind.type).toBe('local');

    // opencode.json must be UNCHANGED.
    const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Record<string, any>;
    expect(jsonContent.theme).toBe('dark');
    expect(jsonContent.mcp.github.command).toBe('gh-mcp');
    expect(jsonContent.mcp.mind).toBeUndefined();
  });

  test('does not create opencode.json when opencode.jsonc exists', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsoncPath = join(opencodeDir, 'opencode.jsonc');
    const jsonPath = join(opencodeDir, 'opencode.json');

    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(jsoncPath, '// initial\n{ "theme": "dark" }\n');

    await runSetup('opencode');

    expect(existsSync(jsoncPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
  });

  test('uses opencode.jsonc when only opencode.jsonc exists', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsoncPath = join(opencodeDir, 'opencode.jsonc');

    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(
      jsoncPath,
      '/* header */\n{ "theme": "dark", "mcp": { "github": { "command": "g" } } }\n'
    );

    await runSetup('opencode');

    // The opencode.jsonc file was the file that got updated. opencode.json
    // must NOT have been created.
    expect(existsSync(join(opencodeDir, 'opencode.json'))).toBe(false);
    expect(existsSync(jsoncPath)).toBe(true);
    const after = readFileSync(jsoncPath, 'utf-8');
    const parsed = JSON.parse(stripJsoncComments(after)) as Record<string, any>;
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.github.command).toBe('g');
    expect(parsed.mcp.mind).toBeDefined();
  });

  test('rewrites opencode.jsonc as parseable JSONC with merged config', async () => {
    // The setup adds the `instructions` top-level key. jsonc-parser cannot
    // preserve the document structure across key set changes, so the file
    // is cleanly rewritten. The contract here is that the resulting file
    // is still parseable as JSONC and contains the merged mind config.
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsoncPath = join(opencodeDir, 'opencode.jsonc');

    mkdirSync(opencodeDir, { recursive: true });
    const original = [
      '// top-level config note',
      '{',
      '  "theme": "dark",',
      '  "mcp": { "github": { "command": "g" } }',
      '}',
      '',
    ].join('\n');
    writeFileSync(jsoncPath, original);

    await runSetup('opencode');

    const after = readFileSync(jsoncPath, 'utf-8');
    // mind config is merged in.
    expect(after).toContain('"mind"');
    expect(after).toContain('"github"');
    // The file is still valid JSONC (no syntactic damage from a partial
    // write).
    expect(() => JSON.parse(stripJsoncComments(after))).not.toThrow();
  });

  test('aborts setup and leaves file untouched when opencode.json is malformed', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsonPath = join(opencodeDir, 'opencode.json');

    mkdirSync(opencodeDir, { recursive: true });
    const original = '{ "theme": "dark", "mcp": '; // truncated
    writeFileSync(jsonPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('opencode');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message ?? '')).toMatch(/malformed|setup/i);

    // File must remain byte-for-byte identical (no truncation, no rewrite).
    expect(readFileSync(jsonPath, 'utf-8')).toBe(original);
  });

  test('aborts setup and leaves file untouched when opencode.jsonc is malformed', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsoncPath = join(opencodeDir, 'opencode.jsonc');

    mkdirSync(opencodeDir, { recursive: true });
    const original = '{ "theme": "dark", "mcp":'; // truncated
    writeFileSync(jsoncPath, original);

    let caught: Error | null = null;
    try {
      await runSetup('opencode');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(String(caught?.message ?? '')).toMatch(/malformed|setup/i);

    expect(readFileSync(jsoncPath, 'utf-8')).toBe(original);
  });

  test('backs up opencode.json before mutating it', async () => {
    const opencodeDir = join(tempHome, '.config', 'opencode');
    const jsonPath = join(opencodeDir, 'opencode.json');

    mkdirSync(opencodeDir, { recursive: true });
    const original = { theme: 'dark', mcp: { github: { command: 'gh' } } };
    writeFileSync(jsonPath, JSON.stringify(original, null, 2));

    await runSetup('opencode');

    // Look for a sibling backup that contains the pre-setup content.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const entries = readdirSync(opencodeDir).filter(name => name.startsWith('opencode.json.bak.'));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const backup = JSON.parse(
      readFileSync(join(opencodeDir, entries[0] as string), 'utf-8')
    ) as Record<string, any>;
    expect(backup.theme).toBe('dark');
    expect(backup.mcp.github.command).toBe('gh');
  });

  test('plugin default-exports an OpenCode v2 definition with id and setup', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    expect(pluginText).toContain('export default {');
    expect(pluginText).toContain("id: 'mind-automation'");
    expect(pluginText).toContain('setup: buildV2Setup');
    // V1 runtimes read server() and ignore the V2 fields.
    expect(pluginText).toContain('server: MindAutomationPlugin');
  });

  test('plugin registers v2 session hooks for context and compaction', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    expect(pluginText).toContain("ctx.session.hook('context'");
    expect(pluginText).toContain("ctx.session.hook('compaction'");
    expect(pluginText).toContain('ctx.event.subscribe');
    // V2 system prompt is an array of parts, not a mutable string.
    expect(pluginText).toContain("event.system.push({ type: 'text', text })");
    // V2 event/session payloads expose sessionID.
    expect(pluginText).toContain('payload.sessionID');
  });

  test('plugin reads v2 location context instead of v1 worktree/directory', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    expect(pluginText).toContain('ctx.location.directory');
    expect(pluginText).toContain('ctx.location.project.canonical');
  });
});
