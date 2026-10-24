// Data-driven agent configuration for setup.ts
// Replaces the ~400-line inline object map with a config array

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'path';

import type { CapabilityMap, SupportedAgent } from '../cli/capabilities';
import { getAgentCapabilities, getSupportedAgentDefinition } from '../cli/capabilities';

export interface AgentConfigEntry {
  name: string;
  configPath: string;
  format: 'json' | 'toml';
  build: (
    _mcpUrl: string,
    _mindPath: string,
    _identity: SupportedAgent,
    _existingEnvironment?: Record<string, string>
  ) => string | Record<string, unknown>;
  capabilities: CapabilityMap;
}

function getHomeDir(): string {
  return process.env.HOME ?? homedir();
}

// Environment entries are string-only so both JSON and TOML carry the same
// shape. MIND_AGENT is always first and wins over an inherited value.
function withAgentIdentity(
  identity: SupportedAgent,
  existingEnvironment: Record<string, string>
): Record<string, string> {
  const environment: Record<string, string> = { MIND_AGENT: identity };
  for (const key of Object.keys(existingEnvironment).sort()) {
    if (key !== 'MIND_AGENT') {
      environment[key] = existingEnvironment[key] as string;
    }
  }
  return environment;
}

// JSON config builders for each agent
// Note: build functions receive (_mcpUrl, mindPath) but ignore the first param
function buildJsonMcpConfig(
  _mcpUrl: string,
  mindPath: string,
  identity: SupportedAgent
): Record<string, unknown> {
  return {
    mcpServers: {
      mind: {
        type: 'stdio',
        command: mindPath,
        args: ['mcp'],
        env: withAgentIdentity(identity, {}),
      },
    },
  };
}

function buildOpenCodeMcpConfig(
  _mcpUrl: string,
  mindPath: string,
  identity: SupportedAgent
): Record<string, unknown> {
  return {
    mcp: {
      mind: {
        type: 'local',
        command: [mindPath, 'mcp'],
        enabled: true,
        environment: withAgentIdentity(identity, {}),
      },
    },
  };
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function buildTomlMcpConfig(
  _mcpUrl: string,
  mindPath: string,
  identity: SupportedAgent,
  existingEnvironment: Record<string, string> = {}
): string {
  const environment = withAgentIdentity(identity, existingEnvironment);
  const envEntries = Object.entries(environment)
    .map(([key, value]) => `${formatTomlKey(key)} = ${JSON.stringify(value)}`)
    .join(', ');

  return `\n[mcp_servers.mind]\ncommand = ${JSON.stringify(
    mindPath
  )}\nargs = ["mcp"]\nenv = { ${envEntries} }\n`;
}

// Internal config entry with path components (not yet resolved)
interface AgentConfigInternal {
  agent: SupportedAgent;
  name: string;
  pathComponents: string[]; // Relative path components from home dir
  /**
   * Optional path preference: when set, the resolver picks the first existing
   * path among `pathComponents`/`pathAlternatives`. When none exist, the
   * first listed path is used for the new file. Use this for agents that
   * accept a JSON-with-comments variant (e.g. opencode.jsonc) and prefer it
   * when present.
   */
  pathAlternatives?: string[][];
  format: 'json' | 'toml';
  build: (
    _mcpUrl: string,
    _mindPath: string,
    _identity: SupportedAgent,
    _existingEnvironment?: Record<string, string>
  ) => string | Record<string, unknown>;
  capabilities: CapabilityMap;
}

// Data-driven agent configuration array - keyed by SupportedAgent
// Paths are stored as components, resolved at call time (not module load time)
const AGENT_CONFIGS: AgentConfigInternal[] = [
  {
    agent: 'claude-code',
    name: getSupportedAgentDefinition('claude-code').name,
    pathComponents: ['.claude', 'settings.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('claude-code'),
  },
  {
    // OpenCode accepts both opencode.json and opencode.jsonc. We PREFER
    // opencode.jsonc when it exists, and we NEVER create opencode.json if
    // opencode.jsonc already exists. This avoids creating a second config
    // file that the user did not ask for.
    agent: 'opencode',
    name: getSupportedAgentDefinition('opencode').name,
    pathComponents: ['.config', 'opencode', 'opencode.jsonc'],
    pathAlternatives: [
      ['.config', 'opencode', 'opencode.jsonc'],
      ['.config', 'opencode', 'opencode.json'],
    ],
    format: 'json',
    build: buildOpenCodeMcpConfig,
    capabilities: getAgentCapabilities('opencode'),
  },
  {
    agent: 'codex',
    name: getSupportedAgentDefinition('codex').name,
    pathComponents: ['.codex', 'config.toml'],
    format: 'toml',
    build: buildTomlMcpConfig,
    capabilities: getAgentCapabilities('codex'),
  },
  {
    agent: 'cursor',
    name: getSupportedAgentDefinition('cursor').name,
    pathComponents: ['.cursor', 'mcp.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('cursor'),
  },
  {
    agent: 'windsurf',
    name: getSupportedAgentDefinition('windsurf').name,
    // Documented Windsurf/Devin path. The old ~/.windsurf/mcp.json path is
    // handled as a read-only legacy detection fallback in setup.ts.
    pathComponents: ['.config', 'devin', 'mcp_config.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('windsurf'),
  },
  {
    agent: 'gemini-cli',
    name: getSupportedAgentDefinition('gemini-cli').name,
    pathComponents: ['.gemini', 'settings.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('gemini-cli'),
  },
  {
    agent: 'vscode',
    name: getSupportedAgentDefinition('vscode').name,
    // Portable documented GitHub Copilot MCP path. VS Code's native
    // <userData>/mcp.json with a top-level `servers` object remains an
    // alternative documented shape, but Mind writes only one file.
    pathComponents: ['.copilot', 'mcp-config.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('vscode'),
  },
  {
    agent: 'antigravity',
    name: getSupportedAgentDefinition('antigravity').name,
    pathComponents: ['.gemini', 'config', 'mcp_config.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('antigravity'),
  },
  {
    agent: 'pi',
    name: getSupportedAgentDefinition('pi').name,
    pathComponents: ['.pi', 'agent', 'mcp.json'],
    format: 'json',
    build: buildJsonMcpConfig,
    capabilities: getAgentCapabilities('pi'),
  },
];

// Lookup map for O(1) access by agent type
const AGENT_CONFIG_MAP = new Map<SupportedAgent, AgentConfigInternal>(
  AGENT_CONFIGS.map(cfg => [cfg.agent, cfg])
);

// Resolves the preferred config path for agents that have alternative paths
// (e.g. opencode.jsonc over opencode.json). Returns the first path in
// `alternatives` that exists on disk, or the first listed path if none exist.
function resolvePreferredPath(alternatives: string[][]): string {
  for (const components of alternatives) {
    const candidate = path.join(getHomeDir(), ...components);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(getHomeDir(), ...(alternatives[0] ?? []));
}

// Returns the agent config for a given agent type, with configPath resolved at call time
export function getAgentConfig(agent: SupportedAgent): AgentConfigEntry {
  const config = AGENT_CONFIG_MAP.get(agent);
  if (!config) {
    throw new Error(`Unsupported agent: ${agent}`);
  }

  // Compute configPath dynamically at call time (not module load time)
  const configPath =
    config.pathAlternatives && config.pathAlternatives.length > 0
      ? resolvePreferredPath(config.pathAlternatives)
      : path.join(getHomeDir(), ...config.pathComponents);

  return {
    name: config.name,
    configPath,
    format: config.format,
    build: config.build,
    capabilities: config.capabilities,
  };
}

// Returns all agent configs (for iteration), with configPath resolved at call time
export function getAllAgentConfigs(): AgentConfigEntry[] {
  return AGENT_CONFIGS.map(config => {
    const configPath =
      config.pathAlternatives && config.pathAlternatives.length > 0
        ? resolvePreferredPath(config.pathAlternatives)
        : path.join(getHomeDir(), ...config.pathComponents);
    return {
      name: config.name,
      configPath,
      format: config.format,
      build: config.build,
      capabilities: config.capabilities,
    };
  });
}
