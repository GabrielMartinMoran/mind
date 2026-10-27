export type AgentTransport = 'stdio' | 'http';

export type AgentSource = 'env' | 'client' | 'unknown';

export interface AgentIdentityInput {
  envAgent?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  transport: AgentTransport;
  sessionId?: string | null;
}

export type AgentIdentity = {
  agent: string;
  agentSource: AgentSource;
  clientName: string | null;
  clientVersion: string | null;
  transport: AgentTransport;
  mcpSession: string | null;
};

const MAX_AGENT_NAME_LENGTH = 64;

const AGENT_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'codex-mcp-client': 'codex',
  codex: 'codex',
  'github-copilot': 'vscode',
  copilot: 'vscode',
  'vs-code': 'vscode',
  vscode: 'vscode',
  windsurf: 'windsurf',
  devin: 'windsurf',
  'windsurf/devin': 'windsurf',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  'pi-agent': 'pi',
  pi: 'pi',
  opencode: 'opencode',
  cursor: 'cursor',
  antigravity: 'antigravity',
};

export function normalizeAgentName(raw?: string | null): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const normalized = raw.trim().replace(/\s+/g, '-').toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  const name = AGENT_ALIASES[normalized] ?? normalized;
  return name.slice(0, MAX_AGENT_NAME_LENGTH);
}

export function resolveAgentIdentity(input: AgentIdentityInput): AgentIdentity {
  const envAgent = normalizeAgentName(input.envAgent);
  const clientAgent = normalizeAgentName(input.clientName);

  const preferClient = input.transport === 'http';
  const primary = preferClient ? clientAgent : envAgent;
  const primarySource: AgentSource = preferClient ? 'client' : 'env';
  const fallback = preferClient ? envAgent : clientAgent;
  const fallbackSource: AgentSource = preferClient ? 'env' : 'client';

  let agent = 'unknown';
  let agentSource: AgentSource = 'unknown';
  if (primary) {
    agent = primary;
    agentSource = primarySource;
  } else if (fallback) {
    agent = fallback;
    agentSource = fallbackSource;
  }

  return {
    agent,
    agentSource,
    clientName: input.clientName ?? null,
    clientVersion: input.clientVersion ?? null,
    transport: input.transport,
    mcpSession: input.sessionId ?? null,
  };
}
