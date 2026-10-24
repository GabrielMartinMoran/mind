import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import { DEFAULT_PORT } from '../config';
import { getAgentConfig } from '../setup/agent-config';
import {
  MalformedConfigError,
  readJsoncOrThrow,
  readJsonOrThrow,
  readTomlOrThrow,
  safeWriteJson,
  safeWriteJsonc,
  safeWriteToml,
} from '../setup/safe-config';
import {
  type AgentSkillType,
  ensureMindManagementSkill,
  getAgentSkillLayout,
  getAgentSkillPath,
  getAgentSkillSignalPaths,
  pathExistsLstat,
} from '../setup/skill-installation';
export { buildOpenCodeAutomationPlugin } from '../setup/opencode-automation-plugin';
export { getAgentCapabilities, getAgentCapabilityMatrix } from './capabilities';

import {
  type AgentSkillDeclaration,
  type CapabilityMap,
  type SupportedAgent,
  formatCapabilityBadge,
  formatSkillLine,
  getAgentCapabilityMatrix,
  getAgentSkillDeclaration,
  getSupportedAgents,
} from './capabilities';
import { renderMemoryProtocol } from './memory-protocol';

const DEFAULT_MCP_PORT = 7438;

const OPENCODE_MEMORY_PROTOCOL_FILENAME = 'mind-memory-protocol.md';

const OPENCODE_AUTOMATION_PLUGIN_FILENAME = 'mind-automation.js';

const CLAUDE_MEMORY_PROTOCOL_FILENAME = 'mind-memory-protocol.md';

const CLAUDE_MANAGED_BLOCK_START = '<!-- mind managed protocol start -->';
const CLAUDE_MANAGED_BLOCK_END = '<!-- mind managed protocol end -->';

const CLAUDE_HOOK_SCRIPT_NAME = 'mind-session-summary.sh';
const CLAUDE_HOOKS_OPT_IN_ENV = 'MIND_SETUP_CLAUDE_ENABLE_HOOKS';

const CURSOR_HOOK_SCRIPT_NAME = 'mind-session-continuity.sh';
// Documented Cursor event names. `sessionEnd` is the documented lifecycle end;
// older Mind builds emitted a top-level `stop` map without the documented
// `{ version, hooks }` envelope.
const CURSOR_HOOK_EVENTS = ['sessionStart', 'preCompact', 'sessionEnd', 'stop'] as const;

const LEGACY_PROTOCOL_FILENAMES = [
  'mind-memory-protocol-opencode.md',
  'mind-memory-protocol-claude.md',
  'mind-memory-protocol-claude-code.md',
  'mind-memory-protocol-codex.md',
  'mind-memory-protocol.claude.md',
  'mind-memory-protocol.codex.md',
];

function getHomeDir(): string {
  return process.env.HOME ?? homedir();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getMindScriptPath(): string {
  try {
    const result = spawnSync('command', ['-v', 'mind'], { encoding: 'utf-8', shell: false });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through to absolute path detection
  }

  // From src/cli/, go up 2 levels to repo root, then append 'mind' script name
  const script = path.resolve(__dirname, '..', '..', 'mind');
  if (fs.existsSync(script)) {
    return script;
  }
  return 'mind';
}

/**
 * Builds the `claude mcp add` argv. The `--env` flag follows the server name
 * so the variadic environment list is terminated by the `--` separator.
 */
export function buildClaudeMcpAddArgs(mindPath: string): string[] {
  return [
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
    mindPath,
    'mcp',
  ];
}

export function tryClaudeMcpAdd(mindPath: string): { ok: boolean; reason?: string } {
  // Check if claude CLI is available
  try {
    const check = spawnSync('command', ['-v', 'claude'], { encoding: 'utf-8', shell: false });
    if (check.status !== 0) {
      return { ok: false, reason: 'claude CLI not found in PATH' };
    }
  } catch {
    return { ok: false, reason: 'claude CLI not found in PATH' };
  }

  // Try claude mcp add
  try {
    const result = spawnSync('claude', buildClaudeMcpAddArgs(mindPath), {
      encoding: 'utf-8',
      shell: false,
      stdio: 'pipe',
    });

    if (result.status === 0) {
      return { ok: true };
    } else {
      return { ok: false, reason: result.stderr?.trim() || `exit code ${result.status}` };
    }
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

function getMindEntryPath(): string {
  return path.resolve(__dirname, '..', 'mind.ts');
}

function getPidDir(): string {
  return path.join(homedir(), '.mind');
}

function getPidPath(name: 'mcp' | 'serve'): string {
  return path.join(getPidDir(), `${name}.pid`);
}

function writePid(name: 'mcp' | 'serve', pid: number): void {
  ensureDir(getPidDir());
  fs.writeFileSync(getPidPath(name), String(pid));
}

function readPid(name: 'mcp' | 'serve'): number | null {
  const pidPath = getPidPath(name);
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
  return Number.isFinite(pid) ? pid : null;
}

function clearPid(name: 'mcp' | 'serve'): void {
  const pidPath = getPidPath(name);
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a strict JSON config file. Throws `MalformedConfigError` if the file
 * exists but cannot be parsed. Returns `{}` for a missing file.
 */
function readJson(filePath: string): Record<string, unknown> {
  return readJsonOrThrow(filePath);
}

/**
 * Write a JSON config file atomically with a timestamped backup of the
 * pre-write file. Aborts the calling setup run if the existing file is
 * malformed.
 */
function writeJson(filePath: string, value: Record<string, unknown>): void {
  safeWriteJson(filePath, value);
}

/**
 * Read a JSONC config file (used for opencode.jsonc). Throws on malformed
 * input. Returns `{}` for a missing file.
 */
function readJsonc(filePath: string): Record<string, unknown> {
  return readJsoncOrThrow(filePath);
}

/**
 * Write a JSONC config file with comment-preserving edit. Backups the
 * pre-write file and refuses to overwrite a malformed one.
 */
function writeJsonc(
  filePath: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>
): void {
  safeWriteJsonc(filePath, updater);
}

function readText(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function jsonFileHasMindMcp(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const config = readJson(filePath);
  const mcp = config.mcp as Record<string, unknown> | undefined;
  const mcpServers = config.mcpServers as Record<string, unknown> | undefined;

  return Boolean(mcp?.mind || mcpServers?.mind);
}

/**
 * Extracts the existing string environment entries from the Codex
 * `[mcp_servers.mind]` stanza (inline table or `[mcp_servers.mind.env]`
 * subtable, both normalized by the parser). Non-string scalars are stringified
 * because environment values are strings in the emitted TOML.
 */
function readCodexEnvironment(config: Record<string, unknown>): Record<string, string> {
  const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
  const mind = mcpServers?.mind as Record<string, unknown> | undefined;
  const env = mind?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return {};
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      environment[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      environment[key] = String(value);
    }
  }
  return environment;
}

function tomlFileHasMindMcp(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  // Parse-validates the file. Malformed input throws MalformedConfigError
  // and the caller (isAgentIntegrationDetected / detection path) lets it
  // propagate so the user sees a real parse-failure diagnostic instead of
  // a silent false.
  const config = readTomlOrThrow(filePath);
  const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
  return Boolean(mcpServers?.mind);
}

/**
 * Format-aware detection dispatch. TOML agents (currently codex) must NOT
 * pass through the JSON probe — TOML is not JSON and would always throw,
 * producing misleading diagnostics. JSON/JSONC agents keep the existing
 * JSON probe.
 */
function hasMindMcpInAgentConfig(cfg: { configPath: string; format: 'json' | 'toml' }): boolean {
  if (cfg.format === 'toml') {
    return tomlFileHasMindMcp(cfg.configPath);
  }
  return jsonFileHasMindMcp(cfg.configPath);
}

/**
 * Find the byte range `[start, end)` of a TOML `[dotted.path]` table
 * stanza inside `text`. Returns `null` if no matching table header exists.
 *
 * The end position is the start of the *next* table header line (including
 * array-of-tables `[[...]]` headers) or end-of-file. The intent is to
 * give the caller a single contiguous slice they can replace surgically
 * while leaving preceding/following tables and their comments intact.
 */
function findTomlTableStanzaBounds(
  text: string,
  tablePath: string
): { start: number; end: number } | null {
  const escaped = tablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startPattern = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm');
  const startMatch = startPattern.exec(text);
  if (!startMatch) {
    return null;
  }
  const start = startMatch.index;
  // Skip past the matched header line so endPattern cannot match the same
  // table header again.
  const endPattern = /^[\t ]*\[+[^\]]+\]+\s*$/gm;
  endPattern.lastIndex = start + startMatch[0].length;
  const endMatch = endPattern.exec(text);
  const end = endMatch ? endMatch.index : text.length;
  return { start, end };
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function ensureOpenCodeInstructionPath(): string {
  const instructionsDir = path.join(getHomeDir(), '.config', 'opencode', 'instructions');
  const instructionPath = path.join(instructionsDir, OPENCODE_MEMORY_PROTOCOL_FILENAME);
  ensureDir(instructionsDir);
  removeLegacyProtocolFiles(instructionsDir);
  writeText(instructionPath, renderMemoryProtocol('opencode'));
  return instructionPath;
}

function isLegacyProtocolPath(entry: unknown): boolean {
  if (typeof entry !== 'string') {
    return false;
  }

  return LEGACY_PROTOCOL_FILENAMES.includes(path.basename(entry));
}

function dedupeStringEntries(values: unknown[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    if (!seen.has(value)) {
      deduped.push(value);
      seen.add(value);
    }
  }

  return deduped;
}

function removeLegacyProtocolFiles(baseDir: string): void {
  for (const filename of LEGACY_PROTOCOL_FILENAMES) {
    const candidate = path.join(baseDir, filename);
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
    }
  }
}

function placeInstructionFirst(
  config: Record<string, unknown>,
  instructionPath: string
): Record<string, unknown> {
  const existingInstructions = Array.isArray(config.instructions) ? config.instructions : [];
  const sanitized = dedupeStringEntries(existingInstructions).filter(
    entry => entry !== instructionPath && !isLegacyProtocolPath(entry)
  );
  return {
    ...config,
    instructions: [instructionPath, ...sanitized],
  };
}

// buildOpenCodeAutomationPlugin is now imported from ../setup/opencode-automation-plugin

function ensureOpenCodeAutomationPlugin(mindPath: string): string {
  const pluginsDir = path.join(getHomeDir(), '.config', 'opencode', 'plugins');
  const pluginPath = path.join(pluginsDir, OPENCODE_AUTOMATION_PLUGIN_FILENAME);
  ensureDir(pluginsDir);
  // Import the extracted function
  const { buildOpenCodeAutomationPlugin } = require('../setup/opencode-automation-plugin');
  writeText(pluginPath, buildOpenCodeAutomationPlugin(mindPath));
  return pluginPath;
}

function ensureClaudeInstructionPath(): string {
  const instructionsDir = path.join(getHomeDir(), '.claude', 'instructions');
  const instructionPath = path.join(instructionsDir, CLAUDE_MEMORY_PROTOCOL_FILENAME);
  ensureDir(instructionsDir);
  removeLegacyProtocolFiles(instructionsDir);
  writeText(instructionPath, renderMemoryProtocol('claude-code'));
  return instructionPath;
}

function upsertManagedBlock(content: string, block: string): string {
  const escapedStart = CLAUDE_MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = CLAUDE_MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g');
  const stripped = content
    .replace(pattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  if (stripped.length === 0) {
    return `${block}\n`;
  }

  return `${stripped}\n\n${block}\n`;
}

function ensureClaudeManagedInstructions(instructionPath: string): void {
  const claudeDir = path.join(getHomeDir(), '.claude');
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');

  ensureDir(claudeDir);
  const current = readText(claudeMdPath);

  const managedBody = [
    CLAUDE_MANAGED_BLOCK_START,
    '## Mind activation pointer (managed)',
    '',
    `Source: ${instructionPath}`,
    '',
    renderMemoryProtocol('claude-code').trim(),
    CLAUDE_MANAGED_BLOCK_END,
  ].join('\n');

  const next = upsertManagedBlock(current, managedBody);
  writeText(claudeMdPath, next);
}

function ensureCodexManagedInstructions(): void {
  const codexDir = path.join(getHomeDir(), '.codex');
  const agentsPath = path.join(codexDir, 'AGENTS.md');

  ensureDir(codexDir);
  removeLegacyProtocolFiles(codexDir);
  const current = readText(agentsPath);

  const managedBody = [
    CLAUDE_MANAGED_BLOCK_START,
    '## Mind activation pointer (managed)',
    '',
    renderMemoryProtocol('codex').trim(),
    CLAUDE_MANAGED_BLOCK_END,
  ].join('\n');

  const next = upsertManagedBlock(current, managedBody);
  writeText(agentsPath, next);
}

function ensurePiManagedInstructions(): void {
  const piDir = path.join(getHomeDir(), '.pi', 'agent');
  const agentsPath = path.join(piDir, 'AGENTS.md');

  ensureDir(piDir);
  const current = readText(agentsPath);

  const managedBody = [
    CLAUDE_MANAGED_BLOCK_START,
    '## Mind activation pointer (managed)',
    '',
    renderMemoryProtocol('pi').trim(),
    CLAUDE_MANAGED_BLOCK_END,
  ].join('\n');

  const next = upsertManagedBlock(current, managedBody);
  writeText(agentsPath, next);
}

function shouldEnableClaudeHooks(): boolean {
  const value = (process.env[CLAUDE_HOOKS_OPT_IN_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function hasClaudeHooksSignal(): boolean {
  const home = getHomeDir();
  const hookScriptPath = path.join(home, '.claude', 'hooks', CLAUDE_HOOK_SCRIPT_NAME);
  if (fs.existsSync(hookScriptPath)) {
    return true;
  }

  const settingsText = readText(path.join(home, '.claude', 'settings.json'));
  const fallbackText = readText(path.join(home, '.claude.json'));
  return [settingsText, fallbackText].some(text => text.includes(CLAUDE_HOOK_SCRIPT_NAME));
}

function ensureExecutableScript(filePath: string, content: string): string {
  writeText(filePath, content);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function ensureClaudeHookScript(): string {
  const hooksDir = path.join(getHomeDir(), '.claude', 'hooks');
  ensureDir(hooksDir);

  const scriptPath = path.join(hooksDir, CLAUDE_HOOK_SCRIPT_NAME);
  const script = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v mind >/dev/null 2>&1; then
  exit 0
fi

PROJECT_SPACE="\${MIND_PROJECT_SPACE:-projects/unknown}"
SUMMARY="\${CLAUDE_SESSION_SUMMARY:-Claude session closed. Capture summary via checkpoint and memory tools.}"

mind checkpoint set "$PROJECT_SPACE" "Session close" "Review summary and persist key learnings" --notes "$SUMMARY" >/dev/null 2>&1 || true
`;

  return ensureExecutableScript(scriptPath, script);
}

function ensureCursorHookScript(): string {
  const hooksDir = path.join(getHomeDir(), '.cursor', 'hooks');
  ensureDir(hooksDir);

  const scriptPath = path.join(hooksDir, CURSOR_HOOK_SCRIPT_NAME);
  const script = `#!/usr/bin/env bash
set -euo pipefail

# Mind does not create, overwrite, or complete checkpoints from Cursor hooks.
# Continuity is agent-driven through the mind-management skill so a hook can
# never clobber a real active checkpoint's goal or pending work.
EVENT="\${1:-\${CURSOR_HOOK_EVENT:-unknown}}"

case "$EVENT" in
  sessionStart|preCompact|sessionEnd|stop)
    # Intentional no-op: the lifecycle event is observed but not persisted.
    :
    ;;
  *)
    exit 0
    ;;
esac
`;

  return ensureExecutableScript(scriptPath, script);
}

function withCursorHooksConfig(
  config: Record<string, unknown>,
  hookScriptPath: string
): Record<string, unknown> {
  const next = { ...config };
  const hooksRoot =
    next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
      ? { ...(next.hooks as Record<string, unknown>) }
      : {};

  for (const eventName of CURSOR_HOOK_EVENTS) {
    // Migrate the pre-documented top-level event map if it is still present.
    const legacy = Array.isArray(next[eventName]) ? (next[eventName] as Array<unknown>) : [];
    const current = Array.isArray(hooksRoot[eventName])
      ? (hooksRoot[eventName] as Array<unknown>)
      : [];
    const existing = [...current, ...legacy];

    const isManagedEntry = (entry: unknown): boolean => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      const candidate = entry as { command?: string; args?: unknown };
      return (
        candidate.command === hookScriptPath &&
        Array.isArray(candidate.args) &&
        candidate.args.length === 1 &&
        candidate.args[0] === eventName
      );
    };

    const managedEntry = {
      command: hookScriptPath,
      args: [eventName],
    };

    const withoutManaged = existing.filter(entry => !isManagedEntry(entry));

    hooksRoot[eventName] = [...withoutManaged, managedEntry];
    delete next[eventName];
  }

  next.version = typeof next.version === 'number' && next.version > 0 ? next.version : 1;
  next.hooks = hooksRoot;

  return next;
}

function ensureCursorHooksSetup(): void {
  const cursorDir = path.join(getHomeDir(), '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');

  ensureDir(cursorDir);

  const hookScriptPath = ensureCursorHookScript();
  const currentHooks = readJson(hooksPath);
  const mergedHooks = withCursorHooksConfig(currentHooks, hookScriptPath);

  writeJson(hooksPath, mergedHooks);
}

// Helper to extract stop hooks filtering logic ( Task 3.6)
function filterStopHooksForClaude(
  hooks: Array<{ hooks?: Array<{ command?: string }> }>,
  hookScriptPath: string
): Array<{ hooks?: Array<{ command?: string }> } | null> {
  return hooks
    .map(entry => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      const candidate = entry as { hooks?: Array<{ command?: string }> };
      if (!Array.isArray(candidate.hooks)) {
        return entry;
      }

      const sanitizedHooks = candidate.hooks.filter(hook => hook?.command !== hookScriptPath);
      if (sanitizedHooks.length === 0) {
        return null;
      }

      return {
        ...entry,
        hooks: sanitizedHooks,
      };
    })
    .filter(entry => entry !== null);
}

function withClaudeHooksConfig(
  config: Record<string, unknown>,
  hookScriptPath: string
): Record<string, unknown> {
  const hookEntry = {
    matcher: 'session.stop',
    hooks: [
      {
        type: 'command',
        command: hookScriptPath,
      },
    ],
  };

  const hooksRoot =
    config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
      ? (config.hooks as Record<string, unknown>)
      : {};

  const stopHooks = Array.isArray(hooksRoot.Stop) ? hooksRoot.Stop : [];
  const nextStopHooks = filterStopHooksForClaude(stopHooks, hookScriptPath);

  nextStopHooks.push(hookEntry);

  return {
    ...config,
    hooks: {
      ...hooksRoot,
      Stop: nextStopHooks,
    },
  };
}

function getMcpPort(): number {
  return Number(process.env.MCP_PORT ?? DEFAULT_MCP_PORT);
}

function getWebPort(): number {
  return Number(process.env.MIND_PORT ?? DEFAULT_PORT);
}

export async function startMcpDetached(): Promise<void> {
  const existingPid = readPid('mcp');
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`MCP server already running (pid: ${existingPid})`);
    return;
  }

  const bunPath = process.execPath;
  const mindEntry = getMindEntryPath();
  const port = String(getMcpPort());
  const child = spawn(bunPath, ['run', mindEntry, 'mcp', 'start', '--http', '--port', port], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    console.log('Failed to start MCP server');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  if (!isProcessRunning(child.pid)) {
    console.log(
      'Failed to start MCP server (process exited immediately). Check port availability.'
    );
    return;
  }

  writePid('mcp', child.pid);
  console.log(`✅ MCP server started (pid: ${child.pid}) on http://localhost:${port}/mcp`);
}

export async function stopMcp(): Promise<void> {
  const pid = readPid('mcp');
  if (!pid) {
    console.log('MCP server not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearPid('mcp');
    console.log('MCP server not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  clearPid('mcp');
  console.log(`✅ MCP server stopped (pid: ${pid})`);
}

export async function startServeDetached(port?: number): Promise<void> {
  const existingPid = readPid('serve');
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Web server already running (pid: ${existingPid})`);
    return;
  }

  const bunPath = process.execPath;
  const mindEntry = getMindEntryPath();
  const finalPort = String(port ?? getWebPort());
  const child = spawn(bunPath, ['run', mindEntry, 'serve', 'start', '--port', finalPort], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!child.pid) {
    console.log('Failed to start web server');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  if (!isProcessRunning(child.pid)) {
    console.log(
      'Failed to start web server (process exited immediately). Check port availability.'
    );
    return;
  }

  writePid('serve', child.pid);
  console.log(`✅ Web server started (pid: ${child.pid}) on http://localhost:${finalPort}`);
}

export async function stopServe(): Promise<void> {
  const pid = readPid('serve');
  if (!pid) {
    console.log('Web server not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearPid('serve');
    console.log('Web server not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  clearPid('serve');
  console.log(`✅ Web server stopped (pid: ${pid})`);
}

export async function statusServers(): Promise<void> {
  const mcpPid = readPid('mcp');
  const servePid = readPid('serve');
  const mcpStatus = mcpPid && isProcessRunning(mcpPid) ? `running (pid: ${mcpPid})` : 'stopped';
  const serveStatus =
    servePid && isProcessRunning(servePid) ? `running (pid: ${servePid})` : 'stopped';

  console.log('Mind Servers Status:');
  console.log(`  MCP:  ${mcpStatus}  -> http://localhost:${getMcpPort()}/mcp`);
  console.log(`  Web:  ${serveStatus}  -> http://localhost:${getWebPort()}`);
}

// getAgentConfig is now imported from ../setup/agent-config

function printCapabilityDiagnostics(
  capabilities: CapabilityMap,
  skill?: AgentSkillDeclaration
): void {
  console.log(`   ${formatCapabilityBadge('L1_MCP', capabilities.L1_MCP)}`);
  console.log(`   ${formatCapabilityBadge('L2_INSTRUCTIONS', capabilities.L2_INSTRUCTIONS)}`);
  console.log(`   ${formatCapabilityBadge('L3_HOOKS', capabilities.L3_HOOKS)}`);
  if (skill) {
    console.log(`   ${formatSkillLine(skill)}`);
  }
}

function installAgentSkill(agent: AgentSkillType): void {
  try {
    const skillPath = ensureMindManagementSkill(agent, {
      warn: message => console.log(`⚠️ ${message}`),
    });
    if (skillPath) {
      console.log(`✅ mind-management skill installed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ skill installation failed: ${message}`);
  }
}

// Agent-specific setup handlers (Task 3.4)
async function setupOpenCode(
  merged: Record<string, unknown>,
  mindPath: string
): Promise<Record<string, unknown>> {
  const instructionsPath = ensureOpenCodeInstructionPath();
  let result = placeInstructionFirst(merged, instructionsPath);

  try {
    ensureOpenCodeAutomationPlugin(mindPath);
    console.log(`✅ OpenCode automation plugin configured`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ OpenCode plugin failed: ${message}`);
  }

  installAgentSkill('opencode');

  return result;
}

async function setupClaudeCode(
  merged: Record<string, unknown>,
  _mindPath: string,
  options: RunSetupOptions = {}
): Promise<Record<string, unknown>> {
  const instructionsPath = ensureClaudeInstructionPath();
  ensureClaudeManagedInstructions(instructionsPath);
  console.log(`✅ Claude Code protocol instructions configured`);

  installAgentSkill('claude-code');

  const shouldRefreshHooks = options.refreshExistingClaudeHooks && hasClaudeHooksSignal();
  if (shouldEnableClaudeHooks() || shouldRefreshHooks) {
    try {
      const hookScriptPath = ensureClaudeHookScript();
      merged = withClaudeHooksConfig(merged, hookScriptPath);
      console.log(`✅ Claude hooks configured`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ hooks setup failed: ${message}`);
    }
  } else {
    console.log(`ℹ️ Claude hooks opt-in (set ${CLAUDE_HOOKS_OPT_IN_ENV}=true to enable)`);
  }

  return merged;
}

async function setupCursor(merged: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    ensureCursorHooksSetup();
    console.log(`✅ Cursor global hooks configured`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`⚠️ hooks setup failed: ${message}`);
  }

  installAgentSkill('cursor');

  return merged;
}

async function setupCodex(_configPath: string, _snippet: string): Promise<void> {
  ensureCodexManagedInstructions();
  console.log(`✅ Codex AGENTS protocol configured`);

  installAgentSkill('codex');
}

async function setupWindsurf(): Promise<void> {
  installAgentSkill('windsurf');
}

async function setupGeminiCli(): Promise<void> {
  installAgentSkill('gemini-cli');
}

async function setupVscode(): Promise<void> {
  installAgentSkill('vscode');
}

async function setupAntigravity(): Promise<void> {
  installAgentSkill('antigravity');
}

async function setupPi(): Promise<void> {
  ensurePiManagedInstructions();
  console.log(`✅ Pi AGENTS protocol configured`);

  // Pi has documented extensions, but Mind intentionally ships no Pi plugin.
  installAgentSkill('pi');
}

// Agents that use stdio transport and need URL field removed
const STDIO_TRANSPORT_AGENTS: SupportedAgent[] = [
  'claude-code',
  'cursor',
  'windsurf',
  'gemini-cli',
  'vscode',
  'antigravity',
  'pi',
];

function removeLegacyUrlField(merged: Record<string, unknown>): void {
  const mcpServers = (merged as Record<string, unknown>).mcpServers as
    | Record<string, unknown>
    | undefined;
  if (mcpServers?.mind) {
    delete (mcpServers.mind as Record<string, unknown>).url;
  }
}

export interface RunSetupOptions {
  skipExternalCli?: boolean;
  refreshExistingClaudeHooks?: boolean;
}

export async function runSetup(
  agent: SupportedAgent,
  options: RunSetupOptions = {}
): Promise<void> {
  const cfg = getAgentConfig(agent);
  const mcpUrl = `http://localhost:${getMcpPort()}/mcp`;
  const mindPath = getMindScriptPath();

  // Track claude-code CLI-first approach
  let claudeCliSucceeded = false;
  let claudeFallbackWritePath: string | undefined;

  const isJsonc = cfg.configPath.endsWith('.jsonc');

  if (cfg.format === 'json') {
    // For claude-code, try official CLI first before building merged config
    if (agent === 'claude-code' && !options.skipExternalCli) {
      const cliResult = tryClaudeMcpAdd(mindPath);

      if (cliResult.ok) {
        console.log('  - mind MCP registered via claude mcp add');
        claudeCliSucceeded = true;
      } else {
        console.warn(`  - claude mcp add: ${cliResult.reason}`);
        console.warn('  - Falling back to JSON config...');
        claudeFallbackWritePath = path.join(getHomeDir(), '.claude.json');
      }
    } else if (agent === 'claude-code' && fs.existsSync(path.join(getHomeDir(), '.claude.json'))) {
      claudeFallbackWritePath = path.join(getHomeDir(), '.claude.json');
    }

    // For claude-code fallback path: read from fallback if it exists, otherwise from primary config
    // This ensures existing config (e.g., theme, github server) is preserved when merging
    let readPath = cfg.configPath;
    if (claudeFallbackWritePath) {
      readPath = fs.existsSync(claudeFallbackWritePath) ? claudeFallbackWritePath : cfg.configPath;
    } else if (agent !== 'claude-code') {
      readPath = cfg.configPath;
    }
    let merged: Record<string, unknown>;
    try {
      merged = deepMerge(
        isJsonc ? readJsonc(readPath) : readJson(readPath),
        cfg.build(mcpUrl, mindPath, agent) as Record<string, unknown>
      );
    } catch (err) {
      if (err instanceof MalformedConfigError) {
        console.error(`\n❌ ${err.message}`);
        throw err;
      }
      throw err;
    }

    // Delegate to agent-specific handlers
    if (agent === 'opencode') {
      merged = await setupOpenCode(merged, mindPath);
    } else if (agent === 'claude-code') {
      merged = await setupClaudeCode(merged, mindPath, options);
    } else if (agent === 'cursor') {
      merged = await setupCursor(merged);
    } else if (agent === 'windsurf') {
      await setupWindsurf();
    } else if (agent === 'gemini-cli') {
      await setupGeminiCli();
    } else if (agent === 'vscode') {
      await setupVscode();
    } else if (agent === 'antigravity') {
      await setupAntigravity();
    } else if (agent === 'pi') {
      await setupPi();
    }

    // For stdio transport agents, remove any leftover url field
    if (STDIO_TRANSPORT_AGENTS.includes(agent)) {
      removeLegacyUrlField(merged);
    }

    // For claude-code: skip write if CLI succeeded (CLI handles MCP registration)
    // If CLI failed, write to fallback path (~/.claude.json) instead of settings.json
    if (claudeCliSucceeded) {
      // CLI handled MCP registration, nothing to write
    } else {
      const writePath = claudeFallbackWritePath ?? cfg.configPath;
      if (writePath.endsWith('.jsonc')) {
        writeJsonc(writePath, current => deepMerge(current, merged));
      } else {
        writeJson(writePath, merged);
      }
    }
  } else {
    // TOML agents (currently codex). The contract is parse-safely +
    // backup + atomic + surgical-edit. If a [mcp_servers.mind] stanza
    // already exists and matches the freshly-built snippet, the write
    // is a no-op (no backup, no rewrite). If the existing stanza
    // differs, it is replaced in place, preserving unrelated tables
    // and comments. If no mind stanza exists, the snippet is appended.
    // Malformed existing TOML throws MalformedConfigError and the file
    // is left byte-for-byte unchanged.
    const parsedConfig = readTomlOrThrow(cfg.configPath);

    const current = readText(cfg.configPath);
    const snippet = cfg.build(
      mcpUrl,
      mindPath,
      agent,
      readCodexEnvironment(parsedConfig)
    ) as string;

    // A `[mcp_servers.mind.env]` subtable is a valid table form for the same
    // environment. Fold it into the inline `env` table so replacing the main
    // stanza cannot leave a duplicate definition behind.
    const envBounds = findTomlTableStanzaBounds(current, 'mcp_servers.mind.env');
    const base =
      envBounds === null
        ? current
        : current.slice(0, envBounds.start) + current.slice(envBounds.end);

    const bounds = findTomlTableStanzaBounds(base, 'mcp_servers.mind');

    let nextText: string;
    if (bounds === null) {
      nextText = base.length === 0 ? snippet.replace(/^\n+/, '') : `${base}${snippet}`;
    } else {
      // The snippet carries a leading separator (`\n`) for the append
      // path. When we slice the existing text, the separator lives
      // BEFORE `bounds.start` and is therefore NOT part of the slice.
      // Normalize both sides by stripping leading/trailing whitespace before
      // we decide whether a rewrite would change anything.
      const existingStanza = base.slice(bounds.start, bounds.end);
      const normalize = (s: string): string => s.replace(/^\s+/, '').replace(/\s+$/, '');
      nextText =
        normalize(existingStanza) === normalize(snippet)
          ? base
          : base.slice(0, bounds.start) + snippet + base.slice(bounds.end);
    }

    if (nextText !== current) {
      safeWriteToml(cfg.configPath, nextText);
    }

    if (agent === 'codex') {
      await setupCodex(cfg.configPath, snippet);
    }
  }

  console.log(`✅ Setup complete for ${cfg.name}`);
  if (!claudeCliSucceeded) {
    if (claudeFallbackWritePath) {
      console.log(`   Config written to ~/.claude.json`);
    } else {
      console.log(`   Config updated`);
    }
  }
  printCapabilityDiagnostics(cfg.capabilities, getAgentSkillDeclaration(agent));
}

export async function runSetupAll(): Promise<SupportedAgent[]> {
  const agents = getSupportedAgents() as SupportedAgent[];

  for (const agent of agents) {
    await runSetup(agent);
  }

  console.log(`✅ Setup complete for all ${agents.length} supported agents.`);
  return agents;
}

export interface SetupRefreshOptions {
  mode?: 'detected' | 'all';
  agent?: SupportedAgent;
  dryRun?: boolean;
}

export interface SetupRefreshResult {
  refreshedAgents: SupportedAgent[];
  skippedAgents: SupportedAgent[];
}

function hasAgentSkillSignal(agent: SupportedAgent): boolean {
  // Link-strategy clients have a dedicated directory, so only its SKILL.md is
  // a signal. The shared canonical copy must not make every client look
  // detected after a single install.
  const layout = getAgentSkillLayout(agent);
  if (layout.strategy === 'link') {
    // lstat also recognizes a broken managed symlink, so refresh can repair it.
    return pathExistsLstat(layout.targetDir) || pathExistsLstat(getAgentSkillPath(agent));
  }

  const managedDirs = [layout.canonicalDir, ...layout.shadowDirs];
  const skillPaths = getAgentSkillSignalPaths(agent);
  if (
    !managedDirs.some(managedPath => pathExistsLstat(managedPath)) &&
    !skillPaths.some(skillPath => pathExistsLstat(skillPath))
  ) {
    return false;
  }

  // Shared-strategy clients all resolve the same canonical `~/.agents` skill.
  // Requiring their own config directory prevents one client's install from
  // making every other shared client look detected.
  const cfg = getAgentConfig(agent);
  return fs.existsSync(path.dirname(cfg.configPath));
}

function textFileContains(filePath: string, text: string): boolean {
  return readText(filePath).includes(text);
}

export function isAgentIntegrationDetected(agent: SupportedAgent): boolean {
  const home = getHomeDir();
  const cfg = getAgentConfig(agent);

  if (hasMindMcpInAgentConfig(cfg) || hasAgentSkillSignal(agent)) {
    return true;
  }

  switch (agent) {
    case 'opencode':
      return (
        fs.existsSync(
          path.join(home, '.config', 'opencode', 'instructions', OPENCODE_MEMORY_PROTOCOL_FILENAME)
        ) ||
        fs.existsSync(
          path.join(home, '.config', 'opencode', 'plugins', OPENCODE_AUTOMATION_PLUGIN_FILENAME)
        )
      );
    case 'claude-code':
      return (
        jsonFileHasMindMcp(path.join(home, '.claude.json')) ||
        fs.existsSync(
          path.join(home, '.claude', 'instructions', CLAUDE_MEMORY_PROTOCOL_FILENAME)
        ) ||
        textFileContains(path.join(home, '.claude', 'CLAUDE.md'), CLAUDE_MANAGED_BLOCK_START) ||
        hasClaudeHooksSignal()
      );
    case 'codex':
      return (
        textFileContains(cfg.configPath, '[mcp_servers.mind]') ||
        textFileContains(path.join(home, '.codex', 'AGENTS.md'), CLAUDE_MANAGED_BLOCK_START)
      );
    case 'cursor':
      return (
        (fs.existsSync(path.join(home, '.cursor', 'hooks.json')) &&
          textFileContains(path.join(home, '.cursor', 'hooks.json'), CURSOR_HOOK_SCRIPT_NAME)) ||
        fs.existsSync(path.join(home, '.cursor', 'hooks', CURSOR_HOOK_SCRIPT_NAME))
      );
    case 'windsurf':
      // Read-only legacy detection: the documented path is written above.
      return jsonFileHasMindMcp(path.join(home, '.windsurf', 'mcp.json'));
    case 'gemini-cli':
    case 'vscode':
    case 'antigravity':
      return false;
    case 'pi':
      return textFileContains(
        path.join(home, '.pi', 'agent', 'AGENTS.md'),
        CLAUDE_MANAGED_BLOCK_START
      );
  }
}

function getRefreshCandidateAgents(agent?: SupportedAgent): SupportedAgent[] {
  if (!agent) {
    return getSupportedAgents() as SupportedAgent[];
  }

  if (!getSupportedAgents().includes(agent)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  return [agent];
}

export async function runSetupRefresh(
  options: SetupRefreshOptions = {}
): Promise<SetupRefreshResult> {
  const mode = options.mode ?? 'detected';
  const candidates = getRefreshCandidateAgents(options.agent);
  const refreshedAgents: SupportedAgent[] = [];
  const skippedAgents: SupportedAgent[] = [];

  for (const agent of candidates) {
    const detected = mode === 'all' || isAgentIntegrationDetected(agent);
    if (!detected) {
      skippedAgents.push(agent);
      continue;
    }

    refreshedAgents.push(agent);
    if (options.dryRun) {
      console.log(`Would refresh ${agent}`);
      continue;
    }

    await runSetup(agent, {
      skipExternalCli: true,
      refreshExistingClaudeHooks: true,
    });
  }

  if (refreshedAgents.length === 0) {
    console.log('No detected mind integrations to refresh.');
  } else if (!options.dryRun) {
    console.log(`✅ Refreshed integrations: ${refreshedAgents.join(', ')}`);
  }

  return { refreshedAgents, skippedAgents };
}

function getAgentBadge(status: 'supported' | 'unsupported' | 'unverified'): string {
  return status === 'supported' ? '✅' : status === 'unverified' ? '⚠️' : '🔮';
}

function getCapabilityBadge(
  level: 'L1_MCP' | 'L2_INSTRUCTIONS' | 'L3_HOOKS',
  capabilities: CapabilityMap
): string {
  const cap = capabilities[level];
  if (cap.status === 'supported') return '✅';
  if (cap.status === 'unverified') return '⚠️';
  return '❌';
}

function formatAgentRow(
  agent: string,
  name: string,
  capabilities: CapabilityMap,
  skill: AgentSkillDeclaration
): string {
  // Determine overall badge based on L1_MCP support (L1 is required)
  const overallBadge = getAgentBadge(
    agent.includes('experimental')
      ? 'unverified'
      : agent.includes('roadmap')
        ? 'unsupported'
        : capabilities.L1_MCP.status
  );
  const l1 = getCapabilityBadge('L1_MCP', capabilities);
  const l2 = getCapabilityBadge('L2_INSTRUCTIONS', capabilities);
  const l3 = getCapabilityBadge('L3_HOOKS', capabilities);

  // Truncate name to 12 chars for alignment
  const shortName = name.length > 12 ? name.slice(0, 11) + '…' : name.padEnd(12);
  const skillBadge = getAgentBadge(skill.status);
  return (
    `   ${overallBadge} ${shortName}  L1 ${l1}  L2 ${l2}  L3 ${l3}\n` +
    `      ${skillBadge} skill ${skill.status} (${skill.strategy}) ${skill.path}`
  );
}

export function listAgents(): void {
  console.log('🧠 Agent Compatibility\n');

  for (const { agent, name, capabilities, skill } of getAgentCapabilityMatrix()) {
    console.log(formatAgentRow(agent, name, capabilities, skill));
  }
}
