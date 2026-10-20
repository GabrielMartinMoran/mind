// Fail-closed isolation verification.
//
// After a condition is prepared, the harness runs a set of FREE checks through
// the isolated `opencode` environment and refuses to run any paid prompt until
// every check passes. A single failed check throws `ContaminationError`, and
// the raw command output is saved as evidence next to the run.
//
// The command runner is injected so the PASS and FAIL paths can be unit-tested
// without a real OpenCode install.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  BUILTIN_COMMANDS,
  BUILTIN_PLUGIN_PREFIX,
  BUILTIN_SKILLS,
  MODEL,
  engineForCondition,
  type ConditionId,
} from '../config';
import type { CommandInvocation, CommandRunner } from '../exec';

import type { IsolationDirs } from './opencode';

export interface IsolationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface IsolationReport {
  readonly ok: boolean;
  readonly condition: ConditionId;
  readonly checks: readonly IsolationCheck[];
  readonly evidenceDir: string | null;
}

export class ContaminationError extends Error {
  constructor(
    message: string,
    public readonly reasons: readonly string[],
    public readonly report: IsolationReport
  ) {
    super(message);
    this.name = 'ContaminationError';
  }
}

export interface VerifyIsolationInput {
  readonly condition: ConditionId;
  readonly dir: IsolationDirs;
  readonly env: Record<string, string>;
  readonly runner: CommandRunner;
  readonly evidenceDir: string;
  /**
   * Expected `mind` binary for this unit. When provided, the effective config
   * must wire exactly this path, so `mind-current` can prove it runs the local
   * checkout instead of a stale pinned worktree.
   */
  readonly mindBin?: string | null;
  readonly opencodeBin?: string;
  readonly allowedSkills?: readonly string[];
  readonly allowedPluginPrefix?: string;
  readonly allowedAgents?: readonly string[];
  readonly allowedCommands?: readonly string[];
  /** Injectable sleep for the `mcp list` warm-up retry (tests pass a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Bounded number of `mcp list` attempts before the check fails closed. */
  readonly mcpListAttempts?: number;
  /** Delay between `mcp list` attempts (ms). */
  readonly mcpListRetryMs?: number;
}

/**
 * The managed background service loads MCP config asynchronously after it
 * boots, so the FIRST `mcp list` after a cold start can report "No MCP servers
 * configured" even though the server connects moments later (observed on
 * OpenCode 2.0.28). Retry the list a bounded number of times so a genuinely
 * misconfigured server still fails closed while a warm-up race does not.
 */
const MCP_LIST_ATTEMPTS = 12;
const MCP_LIST_RETRY_MS = 750;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

interface RawDump {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Reserve a free loopback TCP port for this condition's OpenCode background
 * service. Without it the CLI reuses whatever port the user's shared service
 * already holds (and the isolation checks fail closed on the unrelated port
 * conflict). The value is written to the condition's isolated `service.json`.
 */
export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function writeIsolatedServicePort(dir: IsolationDirs, port: number): void {
  const configDir = join(dir.config, 'opencode');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'service.json'), `${JSON.stringify({ port }, null, 2)}\n`, 'utf8');
}

export async function verifyIsolation(input: VerifyIsolationInput): Promise<IsolationReport> {
  const bin = input.opencodeBin ?? 'opencode';
  const childEnv = { ...process.env, ...input.env };
  const dumps: Record<string, RawDump> = {};

  // Give this condition its OWN background-service port so the checks never
  // touch (or conflict with) the user's shared OpenCode service.
  writeIsolatedServicePort(input.dir, await findFreePort());

  const run = async (name: string, args: string[]): Promise<RawDump> => {
    const invocation: CommandInvocation = {
      command: bin,
      args,
      cwd: input.dir.workspace,
      env: childEnv,
    };
    const result = await input.runner(invocation);
    const dump: RawDump = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    dumps[name] = dump;
    return dump;
  };

  const checks: IsolationCheck[] = [];

  // 1. All resolved paths live under the condition directory (except `tmp`).
  const paths = await run('debug-paths', ['debug', 'paths']);
  checks.push(checkPathContainment(paths, input.dir.conditionDir));

  // 2. Effective config pins exactly the authorized model and MCP set.
  const config = await run('debug-config', ['debug', 'config']);
  checks.push(checkEffectiveConfig(config, input.condition, input.mindBin));

  // 3. MCP server list matches the condition (zero, or exactly `mind`).
  //    Retry a bounded number of times to absorb the background-service
  //    warm-up race; a server that never registers still fails closed.
  const sleep = input.sleep ?? defaultSleep;
  const attempts = input.mcpListAttempts ?? MCP_LIST_ATTEMPTS;
  const retryMs = input.mcpListRetryMs ?? MCP_LIST_RETRY_MS;
  let mcp = await run('mcp-list', ['mcp', 'list']);
  for (let attempt = 1; attempt < attempts && !checkMcpList(mcp, input.condition).ok; attempt++) {
    await sleep(retryMs);
    mcp = await run('mcp-list', ['mcp', 'list']);
  }
  checks.push(checkMcpList(mcp, input.condition));

  // 4. No leaked sessions.
  const sessions = await run('session-list', ['session', 'list', '--format', 'json']);
  checks.push(checkEmptyList('sessions', sessions, []));

  // 5-8. No user agents / skills / commands / plugins leak.
  const agents = await run('api-agent', ['api', 'get', '/api/agent']);
  checks.push(checkAllowlisted('agents', agents, input.allowedAgents ?? []));

  const skills = await run('api-skill', ['api', 'get', '/api/skill']);
  checks.push(checkAllowlisted('skills', skills, input.allowedSkills ?? BUILTIN_SKILLS));

  const commands = await run('api-command', ['api', 'get', '/api/command']);
  checks.push(checkAllowlisted('commands', commands, input.allowedCommands ?? BUILTIN_COMMANDS));

  const plugins = await run('api-plugin', ['api', 'get', '/api/plugin']);
  checks.push(checkPluginPrefix(plugins, input.allowedPluginPrefix ?? BUILTIN_PLUGIN_PREFIX));

  // Best-effort: stop the isolated background service any check auto-started so
  // repeated verifications do not accumulate orphan services.
  try {
    await run('service-stop', ['service', 'stop']);
  } catch {
    // Cleanup is best-effort; a failure here never affects the isolation verdict.
  }

  mkdirSync(input.evidenceDir, { recursive: true });
  saveDumps(input.evidenceDir, dumps);

  const report: IsolationReport = {
    ok: checks.every(c => c.ok),
    condition: input.condition,
    checks,
    evidenceDir: input.evidenceDir,
  };

  if (!report.ok) {
    const reasons = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
    throw new ContaminationError(
      `isolation contaminated for condition '${input.condition}': ${reasons.join('; ')}`,
      reasons,
      report
    );
  }

  return report;
}

function saveDumps(evidenceDir: string, dumps: Record<string, RawDump>): void {
  const summary = Object.entries(dumps).map(([name, d]) => {
    writeFileSync(join(evidenceDir, `${name}.stdout.txt`), d.stdout, 'utf8');
    if (d.stderr) writeFileSync(join(evidenceDir, `${name}.stderr.txt`), d.stderr, 'utf8');
    return `${name}: exit=${d.exitCode} stdout=${d.stdout.length}b stderr=${d.stderr.length}b`;
  });
  writeFileSync(join(evidenceDir, 'summary.txt'), `${summary.join('\n')}\n`, 'utf8');
}

function checkPathContainment(dump: RawDump, conditionDir: string): IsolationCheck {
  const leaks: string[] = [];
  for (const line of dump.stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    if (key === 'tmp') continue;
    if (!value.startsWith(conditionDir)) leaks.push(`${key} -> ${value}`);
  }
  if (dump.exitCode !== 0) {
    return {
      name: 'paths-under-condition-dir',
      ok: false,
      detail: `debug paths exit=${dump.exitCode}`,
    };
  }
  return leaks.length === 0
    ? { name: 'paths-under-condition-dir', ok: true, detail: 'all resolved paths contained' }
    : { name: 'paths-under-condition-dir', ok: false, detail: `leaks: ${leaks.join(', ')}` };
}

function extractEffectiveConfig(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      const merged: Record<string, unknown> = {};
      for (const layer of parsed) {
        if (layer && typeof layer === 'object' && layer.info && typeof layer.info === 'object') {
          Object.assign(merged, layer.info as Record<string, unknown>);
        }
      }
      return merged;
    }
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function readModel(config: Record<string, unknown>): {
  providerID: string | null;
  id: string | null;
} {
  const raw = config.model;
  if (typeof raw === 'string') {
    const [providerID, ...rest] = raw.split('/');
    return { providerID: providerID ?? null, id: rest.join('/') || null };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      providerID: typeof obj.providerID === 'string' ? obj.providerID : null,
      id: typeof obj.model === 'string' ? obj.model : typeof obj.id === 'string' ? obj.id : null,
    };
  }
  return { providerID: null, id: null };
}

function readMcpServerNames(config: Record<string, unknown>): string[] {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== 'object') return [];
  const obj = mcp as Record<string, unknown>;
  const servers = obj.servers;
  if (servers && typeof servers === 'object') return Object.keys(servers);
  // v1-flat shape: mcp.<name> entries that are objects.
  return Object.keys(obj).filter(k => k !== 'servers');
}

function readMindCommand(config: Record<string, unknown>): string | null {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== 'object') return null;
  const obj = mcp as Record<string, unknown>;
  const servers =
    obj.servers && typeof obj.servers === 'object' ? (obj.servers as Record<string, unknown>) : obj;
  const mind = servers.mind;
  if (!mind || typeof mind !== 'object') return null;
  const command = (mind as Record<string, unknown>).command;
  return Array.isArray(command) && typeof command[0] === 'string' ? command[0] : null;
}

function checkEffectiveConfig(
  dump: RawDump,
  condition: ConditionId,
  expectedMindBin?: string | null
): IsolationCheck {
  const config = extractEffectiveConfig(dump.stdout);
  if (!config) return { name: 'effective-config', ok: false, detail: 'debug config is not JSON' };

  const model = readModel(config);
  if (model.providerID !== MODEL.providerID || model.id !== MODEL.id) {
    return {
      name: 'effective-config',
      ok: false,
      detail: `model is ${model.providerID}/${model.id}, expected ${MODEL.providerID}/${MODEL.id}`,
    };
  }

  const names = readMcpServerNames(config);
  const isMind = engineForCondition(condition) !== null;
  if (isMind) {
    if (names.length !== 1 || names[0] !== 'mind') {
      return {
        name: 'effective-config',
        ok: false,
        detail: `expected exactly one MCP server 'mind', got [${names.join(', ')}]`,
      };
    }
    if (expectedMindBin) {
      const command = readMindCommand(config);
      if (command !== expectedMindBin) {
        return {
          name: 'effective-config',
          ok: false,
          detail: `mind server runs '${command ?? 'unknown'}', expected '${expectedMindBin}'`,
        };
      }
    }
  } else if (names.length !== 0) {
    return {
      name: 'effective-config',
      ok: false,
      detail: `no-memory must define zero MCP servers, got [${names.join(', ')}]`,
    };
  }
  return {
    name: 'effective-config',
    ok: true,
    detail: `model + mcp ok (${names.join(', ') || 'none'})`,
  };
}

function checkMcpList(dump: RawDump, condition: ConditionId): IsolationCheck {
  const text = dump.stdout;
  const isMind = engineForCondition(condition) !== null;
  if (isMind) {
    return /\bmind\b/.test(text)
      ? { name: 'mcp-list', ok: true, detail: 'mind present (lazy-connect pending)' }
      : { name: 'mcp-list', ok: false, detail: 'mind server not listed' };
  }
  const none = /no mcp servers configured/i.test(text) || text.trim() === '';
  return none
    ? { name: 'mcp-list', ok: true, detail: 'no MCP servers configured' }
    : {
        name: 'mcp-list',
        ok: false,
        detail: `unexpected MCP output: ${text.trim().slice(0, 120)}`,
      };
}

function parseApiList(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { data?: unknown[] }).data)
    ) {
      return (parsed as { data: unknown[] }).data;
    }
    return [];
  } catch {
    return [];
  }
}

function idOf(entry: unknown): string {
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id === 'string') return obj.id;
    if (typeof obj.name === 'string') return obj.name;
  }
  return String(entry);
}

function checkEmptyList(name: string, dump: RawDump, allowed: readonly string[]): IsolationCheck {
  const items = parseApiList(dump.stdout);
  if (items.length === 0) return { name, ok: true, detail: 'empty' };
  const ids = items.map(idOf).filter(id => !allowed.includes(id));
  if (ids.length === 0)
    return { name, ok: true, detail: `only allowed entries: ${allowed.join(', ')}` };
  return { name, ok: false, detail: `unexpected entries: ${ids.join(', ')}` };
}

function checkAllowlisted(name: string, dump: RawDump, allowed: readonly string[]): IsolationCheck {
  const items = parseApiList(dump.stdout);
  const ids = items.map(idOf);
  const leaks = ids.filter(id => !allowed.includes(id));
  return leaks.length === 0
    ? { name: `${name}-allowlisted`, ok: true, detail: `${ids.length} entries, all allowed` }
    : { name: `${name}-allowlisted`, ok: false, detail: `leaks: ${leaks.join(', ')}` };
}

function checkPluginPrefix(dump: RawDump, prefix: string): IsolationCheck {
  const items = parseApiList(dump.stdout);
  const ids = items.map(idOf);
  const leaks = ids.filter(id => !id.startsWith(prefix));
  return leaks.length === 0
    ? { name: 'plugins-allowlisted', ok: true, detail: `${ids.length} builtin plugins` }
    : { name: 'plugins-allowlisted', ok: false, detail: `leaks: ${leaks.join(', ')}` };
}
