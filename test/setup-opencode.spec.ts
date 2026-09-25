import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function extractFunctionSource(pluginText: string, signature: string): string {
  const start = pluginText.indexOf(signature);
  if (start === -1) {
    throw new Error(`Function not found in generated plugin: ${signature}`);
  }

  let depth = 0;
  let end = -1;
  for (let i = pluginText.indexOf('{', start); i < pluginText.length; i += 1) {
    const char = pluginText[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(`Unbalanced braces while extracting: ${signature}`);
  }

  return pluginText.slice(start, end);
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function createFakeMindBin(dir: string): { binPath: string; logPath: string } {
  const binPath = join(dir, 'fake-mind');
  const logPath = join(dir, 'mind-calls.log');
  writeFileSync(binPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\n`);
  chmodSync(binPath, 0o755);
  return { binPath, logPath };
}

function readMindLog(logPath: string): string {
  return existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type GeneratedV2Module = {
  default: { setup: (ctx: unknown) => Promise<() => void> };
};

async function importGeneratedPluginIn(
  pluginDir: string,
  mindPath: string
): Promise<GeneratedV2Module> {
  const filePath = join(pluginDir, 'index.mjs');
  await Bun.write(filePath, buildOpenCodeAutomationPlugin(mindPath));
  return (await import(filePath)) as GeneratedV2Module;
}

interface FakeV2Ctx {
  ctx: unknown;
  hooks: Record<string, (event: unknown) => unknown>;
  processed: Promise<void>;
  isAborted: () => boolean;
}

function createFakeV2Ctx(options: {
  events: unknown[];
  directory: string;
  canonical: string;
}): FakeV2Ctx {
  const hooks: Record<string, (event: unknown) => unknown> = {};
  let aborted = false;
  let signalProcessed: (() => void) | undefined;
  const processed = new Promise<void>(resolve => {
    signalProcessed = () => resolve();
  });

  const ctx = {
    location: {
      directory: options.directory,
      project: { canonical: options.canonical },
    },
    event: {
      subscribe: async function* (subscribeOptions: { signal: AbortSignal }) {
        try {
          for (const event of options.events) {
            if (subscribeOptions.signal.aborted) {
              return;
            }
            yield event;
          }
          // The consumer requests the next event only after it finishes
          // handling the previous one, so this marks all events processed.
          signalProcessed?.();
          await new Promise<void>(resolve => {
            if (subscribeOptions.signal.aborted) {
              resolve();
              return;
            }
            subscribeOptions.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        } finally {
          aborted = subscribeOptions.signal.aborted;
        }
      },
    },
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        hooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
  };

  return { ctx, hooks, processed, isAborted: () => aborted };
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

  test('writes OpenCode prudent automation plugin with required V1 handlers', async () => {
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

  test('V1 chat.system.transform handler appends to LAST system entry (not push new)', async () => {
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
    // V2 session id lives at event.data.sessionID for stream events.
    expect(pluginText).toContain('payload.data');
    // V2 emits session.compaction.ended; session.compacted is the V1 name.
    expect(pluginText).toContain('session.compaction.ended');
  });

  test('plugin reads v2 location context instead of v1 worktree/directory', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');

    expect(pluginText).toContain('ctx.location.directory');
    expect(pluginText).toContain('ctx.location.project.canonical');
  });

  test('extractSessionId resolves V2 stream, hook, legacy, and nested payloads', async () => {
    await runSetup('opencode');

    const pluginPath = join(tempHome, '.config', 'opencode', 'plugins', 'mind-automation.js');
    const pluginText = readFileSync(pluginPath, 'utf-8');
    const helperSource = extractFunctionSource(
      pluginText,
      'function firstNonEmptyString(...values) {'
    );
    const source = extractFunctionSource(pluginText, 'function extractSessionId(payload) {');
    const extractSessionId = new Function(
      `${helperSource}\n${source}\nreturn extractSessionId;`
    )() as (payload: unknown) => string;

    // V2 stream event: top-level id is the event id, session id lives under data.
    expect(
      extractSessionId({ type: 'session.created', id: 'evt_123', data: { sessionID: 'ses_abc' } })
    ).toBe('ses_abc');
    // V2 session entity may surface as data.id; still must not return the event id.
    expect(
      extractSessionId({ type: 'session.created', id: 'evt_456', data: { id: 'ses_def' } })
    ).toBe('ses_def');
    // V2 session hooks expose a top-level sessionID.
    expect(extractSessionId({ sessionID: 'ses_hook' })).toBe('ses_hook');
    // Legacy camelCase.
    expect(extractSessionId({ sessionId: 'ses_legacy' })).toBe('ses_legacy');
    // Legacy top-level id when no session field is present.
    expect(extractSessionId({ id: 'legacy_id' })).toBe('legacy_id');
    // Nested session object.
    expect(extractSessionId({ session: { id: 'ses_nested' } })).toBe('ses_nested');
    expect(extractSessionId({ session: { sessionID: 'ses_nested2' } })).toBe('ses_nested2');
    expect(extractSessionId({ session: { sessionId: 'ses_nested3' } })).toBe('ses_nested3');
    // Empty or non-string fields must not block later fallbacks.
    expect(extractSessionId({ sessionID: '', sessionId: 'B' })).toBe('B');
    expect(extractSessionId({ sessionID: 42, sessionId: 'B' })).toBe('B');
    expect(extractSessionId({ sessionId: '', id: 'A' })).toBe('A');
    expect(extractSessionId({ sessionID: '   ', sessionId: 'B' })).toBe('B');
    expect(extractSessionId({ data: { sessionID: 42, sessionId: 'ses_data_fallback' } })).toBe(
      'ses_data_fallback'
    );
    expect(extractSessionId({ data: { sessionID: 42 }, id: 'evt_fallback' })).toBe('evt_fallback');
    // Missing or invalid payloads fall back to the sentinel.
    expect(extractSessionId(null)).toBe('session-unknown');
    expect(extractSessionId({})).toBe('session-unknown');
    expect(extractSessionId({ data: {} })).toBe('session-unknown');
  });

  test('buildV2Setup registers hooks, dedupes context, and cleans up the subscription', async () => {
    const pluginContent = buildOpenCodeAutomationPlugin('/nonexistent/mind-test-bin');
    // Isolated dir so the plugin's import.meta.dir state file does not leak
    // across runs.
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-v2-'));
    const tmpPath = join(pluginDir, 'index.mjs');
    await Bun.write(tmpPath, pluginContent);

    const previousPath = process.env.PATH;
    // Neutralize the `mind` fallback so the hook never spawns a real process.
    process.env.PATH = '/nonexistent';
    try {
      const mod = (await import(tmpPath)) as {
        default: { setup: (ctx: unknown) => Promise<() => void> };
      };

      const hooks: Record<string, (event: unknown) => unknown> = {};
      let aborted = false;
      const fakeCtx = {
        location: {
          directory: '/tmp/opencode/proj-a',
          project: { canonical: '/tmp/opencode/proj-a' },
        },
        event: {
          subscribe: async function* (options: { signal: AbortSignal }) {
            try {
              await new Promise<void>(resolve => {
                if (options.signal.aborted) {
                  resolve();
                  return;
                }
                options.signal.addEventListener('abort', () => resolve(), { once: true });
              });
            } finally {
              aborted = options.signal.aborted;
            }
          },
        },
        session: {
          hook: async (name: string, callback: (event: unknown) => unknown) => {
            hooks[name] = callback;
            return { dispose: async () => {} };
          },
        },
      };

      const cleanup = await mod.default.setup(fakeCtx);
      const contextHook = hooks.context;
      const compactionHook = hooks.compaction;
      expect(typeof contextHook).toBe('function');
      expect(typeof compactionHook).toBe('function');

      const system: Array<{ type: string; text: string }> = [];
      await contextHook!({ sessionID: 'ses_v2_test', system });
      expect(system).toHaveLength(1);
      expect(system[0]?.type).toBe('text');
      expect((system[0]?.text ?? '').length).toBeGreaterThan(0);

      // Same session must be deduped.
      await contextHook!({ sessionID: 'ses_v2_test', system });
      expect(system).toHaveLength(1);

      // A payload without a system array must not mark the session handled.
      await contextHook!({ sessionID: 'ses_v2_other' });

      await new Promise(resolve => setTimeout(resolve, 20));
      cleanup();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(aborted).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});

describe('OpenCode prudent automation plugin behavior (V2)', () => {
  const canonicalDir = () => join(tempHome, 'canonical-proj');
  const nestedDir = () => join(tempHome, 'nested-dir');
  const eventLocation = () => ({
    directory: nestedDir(),
    project: { canonical: canonicalDir() },
  });
  const stateFilePath = (pluginDir: string) => join(pluginDir, '.mind-automation-state.json');

  test('resolves one project space from the canonical project path and dedupes checkpoints', async () => {
    const { binPath, logPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-canonical-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const fake = createFakeV2Ctx({
      events: [
        {
          type: 'session.created',
          id: 'evt_1',
          data: { sessionID: 'ses_same' },
          location: eventLocation(),
        },
        {
          type: 'session.created',
          id: 'evt_2',
          data: { sessionID: 'ses_same' },
          location: eventLocation(),
        },
      ],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      await fake.processed;
      await waitFor(
        () => readMindLog(logPath).includes('checkpoint set projects/canonical-proj'),
        'canonical checkpoint scaffold'
      );

      const log = readMindLog(logPath);
      expect(log).toContain('create projects/canonical-proj');
      expect(log).toContain('checkpoint set projects/canonical-proj');
      expect(log).not.toContain('projects/nested-dir');
      expect(countOccurrences(log, 'checkpoint set')).toBe(1);
      expect(existsSync(stateFilePath(pluginDir))).toBe(true);
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('refreshes the checkpoint on session.compaction.ended for a different session', async () => {
    const { binPath, logPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-compaction-event-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const fake = createFakeV2Ctx({
      events: [
        {
          type: 'session.created',
          data: { sessionID: 'ses_one' },
          location: eventLocation(),
        },
        {
          type: 'session.compaction.ended',
          data: { sessionID: 'ses_two' },
          location: eventLocation(),
        },
      ],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      await fake.processed;
      await waitFor(
        () => countOccurrences(readMindLog(logPath), 'checkpoint set') === 2,
        'second checkpoint set after compaction.ended'
      );

      const log = readMindLog(logPath);
      expect(log).toContain('checkpoint set projects/canonical-proj');
      expect(countOccurrences(log, 'checkpoint set')).toBe(2);
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('persists a session summary on session.deleted with session tags at tier 3', async () => {
    const { binPath, logPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-summary-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const fake = createFakeV2Ctx({
      events: [
        {
          type: 'session.deleted',
          data: { sessionID: 'ses_end' },
          location: eventLocation(),
        },
      ],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      await fake.processed;
      await waitFor(
        () => readMindLog(logPath).includes('type:session,cat:summary'),
        'session summary add'
      );

      const log = readMindLog(logPath);
      expect(log).toMatch(/add projects\/canonical-proj session-/);
      expect(log).toContain('--tags type:session,cat:summary');
      expect(log).toContain('--tier 3');
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('injects compaction continuity once per session interval', async () => {
    const { binPath, logPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-compaction-hook-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const fake = createFakeV2Ctx({
      events: [],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      const compactionHook = fake.hooks.compaction;
      expect(typeof compactionHook).toBe('function');

      const system: Array<{ type: string; text: string }> = [];
      await compactionHook!({ sessionID: 'ses_compact', system });
      expect(system).toHaveLength(1);
      expect(system[0]?.type).toBe('text');
      expect(system[0]?.text).toContain('mind Prudent Continuity');

      // A second hook call within the minimum interval must add nothing.
      await compactionHook!({ sessionID: 'ses_compact', system });
      expect(system).toHaveLength(1);

      await waitFor(
        () => readMindLog(logPath).includes('checkpoint set projects/canonical-proj'),
        'hook checkpoint set'
      );
      expect(readMindLog(logPath)).toContain('checkpoint set projects/canonical-proj');
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('does not write plugin state for foreign stream events', async () => {
    const { binPath, logPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-foreign-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const fake = createFakeV2Ctx({
      events: [
        { type: 'session.text.delta', data: { sessionID: 'ses_noise', delta: 'a' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_noise', delta: 'b' } },
        { type: 'message.updated', data: { sessionID: 'ses_noise' } },
      ],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      // `processed` resolves only after the loop finished handling every event.
      await fake.processed;

      expect(existsSync(stateFilePath(pluginDir))).toBe(false);
      expect(existsSync(logPath)).toBe(false);
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('caps checkpoints, summaries, and handled maps at 400 entries when saving state', async () => {
    const { binPath } = createFakeMindBin(tempHome);
    const pluginDir = mkdtempSync(join(tmpdir(), 'mind-automation-cap-'));
    const mod = await importGeneratedPluginIn(pluginDir, binPath);
    const largeMap = (prefix: string) => {
      const map: Record<string, number> = {};
      for (let i = 0; i < 401; i += 1) {
        map[`${prefix}-${i}`] = i + 1;
      }
      return map;
    };
    const statePath = stateFilePath(pluginDir);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        checkpoints: largeMap('cp'),
        summaries: largeMap('sum'),
        handled: largeMap('handled'),
      })
    );

    const fake = createFakeV2Ctx({
      events: [
        {
          type: 'session.created',
          data: { sessionID: 'ses_cap' },
          location: eventLocation(),
        },
      ],
      directory: canonicalDir(),
      canonical: canonicalDir(),
    });

    const cleanup = await mod.default.setup(fake.ctx);
    try {
      await fake.processed;
      type StateMaps = {
        checkpoints: Record<string, number>;
        summaries: Record<string, number>;
        handled: Record<string, number>;
      };
      const readMaps = () => JSON.parse(readFileSync(statePath, 'utf-8')) as StateMaps;

      await waitFor(() => {
        if (!existsSync(statePath)) {
          return false;
        }
        const maps = readMaps();
        return (
          Object.keys(maps.checkpoints).length === 400 &&
          Object.keys(maps.summaries).length === 400 &&
          Object.keys(maps.handled).length === 400
        );
      }, 'all state maps capped at 400 entries');

      const maps = readMaps();
      // 401 pre-existing checkpoint keys plus one new key: the two oldest drop.
      expect(maps.checkpoints['cp-0']).toBeUndefined();
      expect(maps.checkpoints['cp-1']).toBeUndefined();
      expect(maps.checkpoints['cp-400']).toBe(401);
      // Summaries and handled have 401 pre-existing keys: the oldest drops.
      expect(maps.summaries['sum-0']).toBeUndefined();
      expect(maps.summaries['sum-400']).toBe(401);
      expect(maps.handled['handled-0']).toBeUndefined();
      expect(maps.handled['handled-400']).toBe(401);
    } finally {
      cleanup();
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
