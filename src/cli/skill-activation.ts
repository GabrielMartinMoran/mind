export const SKILL_NAME = 'mind-management';

const ACTIVATION_TEXT =
  `When the mind MCP server is available, load the \`${SKILL_NAME}\` skill once at session start ` +
  'and again after compaction. The skill is the canonical protocol for retrieval, writing, ' +
  'maintenance, linking, and checkpoints. If the skill cannot be loaded, call ' +
  '`system_instructions` for the complete protocol.';

const SKILL_LOAD_NOTE_TEXT =
  'Canonical Mind protocol: load this skill at session start and again after compaction. ' +
  'If it cannot be loaded, call `system_instructions` for the complete protocol.';

/** Brief activation shared by L2 instructions and the MCP initialize handshake. */
export function renderSkillActivation(): string {
  return ACTIVATION_TEXT;
}

/** Self-load note placed after the skill frontmatter and before the protocol body. */
export function renderSkillLoadNote(): string {
  return SKILL_LOAD_NOTE_TEXT;
}
