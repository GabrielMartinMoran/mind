export const SKILL_NAME = 'mind-management';

const ACTIVATION_TEXT =
  `\`${SKILL_NAME}\` is Mind's single source of truth. Load it unconditionally at session start ` +
  'and after compaction, before any Mind use; do not call a Mind MCP tool until loaded. ' +
  'AGENTS.md, L2, MCP initialize, tool descriptions, and docs are pointers only; they do not ' +
  'replace the skill. If the skill is not listed or cannot be loaded, call ' +
  '`system_instructions` and follow it.';

const SKILL_LOAD_NOTE_TEXT =
  `\`${SKILL_NAME}\` is Mind's single source of truth. Load it unconditionally before any Mind ` +
  'use and again after compaction. AGENTS.md, L2, MCP initialize, tool descriptions, and docs ' +
  'are pointers only; they do not replace the skill. If the skill is not listed or cannot be ' +
  'loaded, call `system_instructions` and follow it.';

/** Brief activation shared by L2 instructions and the MCP initialize handshake. */
export function renderSkillActivation(): string {
  return ACTIVATION_TEXT;
}

/** Self-load note placed after the skill frontmatter and before the protocol body. */
export function renderSkillLoadNote(): string {
  return SKILL_LOAD_NOTE_TEXT;
}
