export type SupportedAgent =
  | 'claude-code'
  | 'opencode'
  | 'codex'
  | 'cursor'
  | 'windsurf'
  | 'gemini-cli'
  | 'vscode'
  | 'antigravity'
  | 'pi';
export type ExperimentalAgent = never;
export type Agent = SupportedAgent;

export type CapabilityLevel = 'L1_MCP' | 'L2_INSTRUCTIONS' | 'L3_HOOKS';
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';
export type SkillStrategy = 'shared' | 'symlink' | 'copy';

/**
 * Skill installation is a separate surface from L1/L2/L3, not a fourth badge.
 * `path` is the documented path the client reads, relative to the user's home.
 */
export interface AgentSkillDeclaration {
  status: CapabilityStatus;
  path: string;
  strategy: SkillStrategy;
  evidence: string;
}

export interface CapabilityDeclaration {
  status: CapabilityStatus;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  fallback: string;
}

export type CapabilityMap = Record<CapabilityLevel, CapabilityDeclaration>;

export interface CapabilityMatrixEntry {
  agent: Agent | ExperimentalAgent;
  name: string;
  capabilities: CapabilityMap;
  skill: AgentSkillDeclaration;
}

export interface SupportedAgentDefinition {
  agent: SupportedAgent;
  name: string;
  capabilities: CapabilityMap;
  skill: AgentSkillDeclaration;
}

const CLAUDE_HOOKS_OPT_IN_ENV = 'MIND_SETUP_CLAUDE_ENABLE_HOOKS';

export const CAPABILITY_LABELS: Record<CapabilityLevel, string> = {
  L1_MCP: 'L1 MCP transport',
  L2_INSTRUCTIONS: 'L2 instruction/protocol injection',
  L3_HOOKS: 'L3 hooks/session/compaction automation',
};

export const CANONICAL_SKILL_PATH = '~/.agents/skills/mind-management';

function sharedSkill(evidence: string): AgentSkillDeclaration {
  return { status: 'supported', path: CANONICAL_SKILL_PATH, strategy: 'shared', evidence };
}

function linkedSkill(path: string, evidence: string): AgentSkillDeclaration {
  return { status: 'supported', path, strategy: 'symlink', evidence };
}

const SUPPORTED_AGENT_CAPABILITIES: SupportedAgentDefinition[] = [
  {
    agent: 'claude-code',
    name: 'Claude Code',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'high',
        evidence: 'Uses official claude mcp add CLI when available; falls back to ~/.claude.json.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'supported',
        confidence: 'high',
        evidence:
          'Writes managed protocol markdown and injects/refreshes a managed section in ~/.claude/CLAUDE.md.',
        fallback: 'If file writes fail, use AGENTS.md and MCP system_instructions manually.',
      },
      L3_HOOKS: {
        status: 'supported',
        confidence: 'medium',
        evidence: `Opt-in hook automation available via ${CLAUDE_HOOKS_OPT_IN_ENV}=true; setup writes a managed hook script and non-destructively appends a Stop hook entry.`,
        fallback: `Default remains non-hook mode; run session/compaction protocol manually if opt-in is disabled or unsupported by local Claude tooling.`,
      },
    },
    skill: linkedSkill(
      '~/.claude/skills/mind-management',
      'Claude Code does not read ~/.agents/skills, so setup links ~/.claude/skills/mind-management to the canonical skill (managed-copy fallback). Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'opencode',
    name: 'OpenCode',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'high',
        evidence:
          'Writes ~/.config/opencode/opencode.json mcp.mind local command transport configuration.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'supported',
        confidence: 'high',
        evidence:
          'Injects managed mind-memory-protocol.md path first, exact-once, with the shared Mind protocol body.',
        fallback: 'N/A',
      },
      L3_HOOKS: {
        status: 'supported',
        confidence: 'medium',
        evidence:
          'OpenCode prudent automation is configured by default; setup writes a managed plugin that default-exports an OpenCode V2 definition (id + setup using ctx.session.hook context/compaction and ctx.event.subscribe) with V1 server() hooks kept for compatibility, covering session.created, session.compacted/session.compaction.ended, and compaction context injection.',
        fallback:
          'If plugin write or hook execution fails, setup continues and the managed protocol file keeps the manual continuity workflow available.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management; managed ~/.config/opencode/skills shadow copies are migrated. Client skill discovery was not live-validated in this task.'
    ),
  },
  {
    agent: 'codex',
    name: 'Codex',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'medium',
        evidence: 'Writes [mcp_servers.mind] stanza in ~/.codex/config.toml.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'supported',
        confidence: 'high',
        evidence: 'Upserts a managed protocol block in ~/.codex/AGENTS.md non-destructively.',
        fallback:
          'If AGENTS.md write fails, use repository protocol docs and MCP system instructions manually.',
      },
      L3_HOOKS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'Codex now documents lifecycle hooks, but Mind does not implement Codex hook automation.',
        fallback: 'Run session closure protocol manually.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management. Client skill discovery was not live-validated in this task.'
    ),
  },
  {
    agent: 'cursor',
    name: 'Cursor',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'high',
        evidence: 'Writes ~/.cursor/mcp.json mcpServers.mind with stdio command transport.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'unverified',
        confidence: 'low',
        evidence:
          'No concrete instruction/protocol injection path implemented or validated for Cursor.',
        fallback: 'Use AGENTS.md / manual protocol guidance until verified.',
      },
      L3_HOOKS: {
        status: 'unverified',
        confidence: 'medium',
        evidence:
          'Writes the documented ~/.cursor/hooks.json schema ({version:1,hooks:{sessionStart,sessionEnd,preCompact,stop}}) and a managed script under ~/.cursor/hooks/. Hook execution was not live-validated.',
        fallback:
          'If hook file/script writes fail, setup continues and manual checkpoint/session continuity workflow remains available.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management; managed ~/.cursor/skills shadow copies are migrated. Cursor also documents ~/.cursor/skills. Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'windsurf',
    name: 'Windsurf / Devin',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'medium',
        evidence:
          'Writes the documented ~/.config/devin/mcp_config.json mcpServers.mind stdio transport. The legacy ~/.windsurf/mcp.json path is detection-only.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'No managed instruction/protocol injection for Windsurf/Devin; the shared skill is still installed and documented in the skill surface.',
        fallback: 'Use manual protocol prompts or the installed skill.',
      },
      L3_HOOKS: {
        status: 'unsupported',
        confidence: 'high',
        evidence: 'No hooks/session automation code for Windsurf/Devin.',
        fallback: 'Execute workflow steps manually.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management; Windsurf/Devin documents ~/.config/devin/skills and ~/.agents/skills. Managed ~/.config/devin/skills shadows are migrated. Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'gemini-cli',
    name: 'Gemini CLI',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'high',
        evidence: 'Writes ~/.gemini/settings.json mcpServers.mind with stdio command transport.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'unsupported',
        confidence: 'high',
        evidence: 'No managed instruction/protocol injection is implemented for Gemini CLI.',
        fallback: 'Use project protocol docs manually.',
      },
      L3_HOOKS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'Gemini CLI documents hooks, but Mind does not implement Gemini CLI hook automation.',
        fallback: 'Perform session and compaction actions manually.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management after migrating any managed ~/.gemini/skills shadow copy. Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'vscode',
    name: 'VS Code / GitHub Copilot',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'medium',
        evidence:
          'Writes the portable documented ~/.copilot/mcp-config.json with mcpServers.mind stdio transport. VS Code-native mcp.json with a top-level servers object is documented as an alternative and is not written.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'No managed instruction/protocol injection for VS Code/Copilot; the shared skill is still installed and documented in the skill surface.',
        fallback: 'Use repository protocol files or the installed skill manually.',
      },
      L3_HOOKS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'VS Code/Copilot documents hooks, but Mind does not implement VS Code/Copilot hook automation.',
        fallback: 'Run session continuity steps manually.',
      },
    },
    skill: sharedSkill(
      'Installed once at ~/.agents/skills/mind-management; VS Code/Copilot documents ~/.copilot/skills, ~/.claude/skills, and ~/.agents/skills. Managed ~/.copilot/skills shadows are migrated. Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'antigravity',
    name: 'Antigravity',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'medium',
        evidence:
          'Writes the documented ~/.gemini/config/mcp_config.json mcpServers.mind stdio transport. The legacy ~/.gemini/antigravity/mcp_config.json path is no longer written.',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'No L2 instruction/protocol injection for Antigravity. Skill installation is a separate surface: setup links ~/.gemini/config/skills/mind-management to the canonical skill.',
        fallback:
          'Use repository protocol files, the MCP system_instructions fallback, or the installed skill manually.',
      },
      L3_HOOKS: {
        status: 'unsupported',
        confidence: 'high',
        evidence:
          'Antigravity documents hooks, but Mind does not implement Antigravity hook automation.',
        fallback: 'Run session continuity steps manually.',
      },
    },
    skill: linkedSkill(
      '~/.gemini/config/skills/mind-management',
      'Antigravity does not read ~/.agents/skills globally, so setup links ~/.gemini/config/skills/mind-management to the canonical skill (managed-copy fallback) and migrates the legacy ~/.gemini/antigravity/skills shadow. Client skill discovery was not live-validated.'
    ),
  },
  {
    agent: 'pi',
    name: 'Pi Agent',
    capabilities: {
      L1_MCP: {
        status: 'supported',
        confidence: 'high',
        evidence:
          'Writes ~/.pi/agent/mcp.json with mcpServers.mind stdio transport (the documented Pi user MCP configuration).',
        fallback: 'N/A',
      },
      L2_INSTRUCTIONS: {
        status: 'supported',
        confidence: 'high',
        evidence:
          'Upserts a brief managed activation block in ~/.pi/agent/AGENTS.md non-destructively.',
        fallback: 'Use the installed skill or MCP system_instructions manually.',
      },
      L3_HOOKS: {
        status: 'unverified',
        confidence: 'low',
        evidence:
          'Pi documents extensions, but Mind does not build a Pi plugin, and no Pi hook behavior was live-validated.',
        fallback: 'Run session continuity steps manually.',
      },
    },
    skill: sharedSkill(
      'Pi explicitly discovers ~/.agents/skills, so the canonical skill is used directly. Managed ~/.pi/agent/skills shadow copies are migrated. Client skill discovery was not live-validated in this task.'
    ),
  },
];

const SUPPORTED_AGENT_BY_ID = new Map(
  SUPPORTED_AGENT_CAPABILITIES.map(entry => [entry.agent, entry])
);

export function getSupportedAgentDefinition(agent: SupportedAgent): SupportedAgentDefinition {
  const definition = SUPPORTED_AGENT_BY_ID.get(agent);
  if (!definition) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  return definition;
}

// Compact badge format for inline capability display
export function formatCapabilityBadge(
  level: CapabilityLevel,
  capability: CapabilityDeclaration
): string {
  const statusIcon =
    capability.status === 'supported' ? '✅' : capability.status === 'unverified' ? '⚠️' : '❌';
  const shortLabel =
    level === 'L1_MCP' ? 'L1 MCP' : level === 'L2_INSTRUCTIONS' ? 'L2 inject' : 'L3 hooks';
  return `${statusIcon} ${shortLabel}: ${statusIcon} ${capability.status} (${capability.confidence})`;
}

// Verbose single-line format (for backward compatibility with tests)
export function formatCapabilityLine(
  level: CapabilityLevel,
  capability: CapabilityDeclaration
): string {
  return `- ${CAPABILITY_LABELS[level]}: ${capability.status} (confidence: ${capability.confidence}, evidence: ${capability.evidence}, fallback: ${capability.fallback})`;
}

export function formatSkillLine(skill: AgentSkillDeclaration): string {
  return `- Skill installation: ${skill.status} (strategy: ${skill.strategy}, path: ${skill.path}, evidence: ${skill.evidence})`;
}

export function getAgentCapabilities(agent: Agent): CapabilityMap {
  return getSupportedAgentDefinition(agent).capabilities;
}

export function getAgentSkillDeclaration(agent: Agent): AgentSkillDeclaration {
  return getSupportedAgentDefinition(agent).skill;
}

export function getAgentCapabilityMatrix(): CapabilityMatrixEntry[] {
  return SUPPORTED_AGENT_CAPABILITIES.map(definition => ({
    agent: definition.agent,
    name: definition.name,
    capabilities: definition.capabilities,
    skill: definition.skill,
  }));
}

export function isAgent(value: string): value is Agent {
  return (
    value === 'claude-code' ||
    value === 'opencode' ||
    value === 'codex' ||
    value === 'cursor' ||
    value === 'windsurf' ||
    value === 'gemini-cli' ||
    value === 'vscode' ||
    value === 'antigravity' ||
    value === 'pi'
  );
}

export function getSupportedAgents(): string[] {
  return Array.from(SUPPORTED_AGENT_BY_ID.keys());
}
