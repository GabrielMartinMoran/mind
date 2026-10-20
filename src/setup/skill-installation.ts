// Skill installation for mind-management skill across all agent types
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import { renderMindManagementSkill } from '../cli/mind-management-skill';

// Supported agent types that can have skills installed
export type AgentSkillType =
  | 'opencode'
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini-cli'
  | 'vscode'
  | 'windsurf'
  | 'antigravity';

// Agent-specific paths for skill installation
export interface AgentSkillPaths {
  skillsDir: string;
}

// Map each agent type to its skill installation directory
function getAgentSkillPaths(agent: AgentSkillType): AgentSkillPaths {
  const home = process.env.HOME ?? homedir();

  switch (agent) {
    case 'opencode':
      return {
        skillsDir: path.join(home, '.config', 'opencode', 'skills', 'mind-management'),
      };
    case 'claude-code':
      return {
        skillsDir: path.join(home, '.claude', 'skills', 'mind-management'),
      };
    case 'cursor':
      return {
        skillsDir: path.join(home, '.cursor', 'skills', 'mind-management'),
      };
    case 'codex':
    case 'windsurf':
    case 'vscode':
      // Shared ~/.agents/skills for cross-agent compatibility
      return {
        skillsDir: path.join(home, '.agents', 'skills', 'mind-management'),
      };
    case 'gemini-cli':
      return {
        skillsDir: path.join(home, '.gemini', 'skills', 'mind-management'),
      };
    case 'antigravity':
      return {
        skillsDir: path.join(home, '.gemini', 'antigravity', 'skills', 'mind-management'),
      };
  }
}

// Source path for the bundled mind-management skill
export function getSkillSourcePath(): string {
  return path.resolve(__dirname, '..', 'resources', 'skill-mind-management.md');
}

// Ensure the mind-management skill is installed for a given agent
// Returns the installed skill path on success, null if skill bundle is missing
export function ensureMindManagementSkill(agent: AgentSkillType): string | null {
  const skillFile = getSkillSourcePath();

  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const { skillsDir } = getAgentSkillPaths(agent);
  const destPath = path.join(skillsDir, 'SKILL.md');

  ensureDir(skillsDir);
  const skillContent = renderMindManagementSkill();
  fs.writeFileSync(destPath, skillContent);

  return destPath;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
