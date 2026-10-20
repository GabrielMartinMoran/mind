// Scenario B11 — skill-first activation and pending-work continuity.
//
// Session 1 asks the agent to record an unresolved release-checklist item and
// leave an active checkpoint with pending work. Session 2 resumes that pending
// work and writes `resume.txt`. The unit installs the canonical
// `mind-management` skill (through the real `mind setup opencode`) before any
// session, and the isolation gate allows that one skill.
//
// This scenario is PAID and gated: it declares `requires: ['mind-memory']` and
// never runs under `no-memory`. The assertion reads the raw transcripts (a
// `skill` tool call with id `mind-management`) plus the unit's own Mind database
// and the workspace artifact. It never grades the agent's prose.
//
// LIMITATION: the harness records tool names reliably and tool arguments
// best-effort (the raw `message.list` payload). If a provider/OpenCode build
// drops `state.input`, the skill-id check cannot be proven from the transcript;
// the assertion reports that limitation instead of inventing a pass.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUILTIN_SKILLS } from '../../../config';
import { inspectAllMemories } from '../../../mind/inspect';
import { toolServerPrefix } from '../../../opencode/driver';
import type {
  BSessionResult,
  Scenario,
  ScenarioAssertionContext,
  ScenarioAssertionResult,
  ScenarioSeedContext,
} from '../../scenario';

export const B11_SKILL_ID = 'mind-management';
export const B11_ALLOWED_SKILLS: readonly string[] = [...BUILTIN_SKILLS, B11_SKILL_ID];
export const B11_ARTIFACT_FILE = 'resume.txt';
/** Pending item the second session must recover from memory. */
export const B11_PENDING_ITEM = 'verify the release notes before publishing';
export const B11_PENDING_MARKERS = ['release', 'note'] as const;

export const B11_PROMPTS = [
  [
    'You are working on the project in the current directory.',
    '',
    `The release checklist has one unresolved item: ${B11_PENDING_ITEM}.`,
    '',
    'Use the available project memory tools to:',
    '- record the unresolved release-checklist item as pending work;',
    '- leave an active checkpoint containing that pending item for the next session.',
    '',
    'Do not complete or delete the checkpoint.',
  ].join('\n'),
  [
    'Continue working on the project in the current directory.',
    '',
    'Resume the pending release-checklist item left by the previous session.',
    '',
    `Write the pending item to \`${B11_ARTIFACT_FILE}\` in the current directory.`,
  ].join('\n'),
];

/** Absolute path of the L2 activation written by `mind setup opencode`. */
export function l2InstructionPath(home: string): string {
  return join(home, '.config', 'opencode', 'instructions', 'mind-memory-protocol.md');
}

/**
 * Add the installed L2 activation file to the session config so the real
 * sessions load the same brief activation the product installs. Only the
 * benchmark's inline config is touched; no product code changes.
 */
export function addL2InstructionToEnv(env: Record<string, string>, instructionPath: string): void {
  const content = env.OPENCODE_CONFIG_CONTENT;
  if (!content) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return;
  }
  const existing = Array.isArray(parsed.instructions)
    ? (parsed.instructions as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string'
      )
    : [];
  parsed.instructions = [instructionPath, ...existing.filter(entry => entry !== instructionPath)];
  env.OPENCODE_CONFIG_CONTENT = `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Install the canonical skill and L2 activation in the unit HOME. */
export async function seedB11(ctx: ScenarioSeedContext): Promise<void> {
  if (!ctx.mindBin || !ctx.mindDb) return;

  // Merge the host env for PATH/interpreter lookup; the isolated HOME/XDG and
  // MIND_* pointers in `ctx.env` always win, so the live home and DB are never
  // used.
  const env: Record<string, string | undefined> = { ...process.env, ...ctx.env };
  const result = await ctx.run({
    command: ctx.mindBin,
    args: ['setup', 'opencode'],
    env,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `B11 seed failed (mind setup opencode): ${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  const home = ctx.env.HOME;
  if (home) {
    addL2InstructionToEnv(ctx.env, l2InstructionPath(home));
  }
}

// ── Raw transcript helpers ───────────────────────────────────────────────────

export interface ToolInvocation {
  readonly name: string;
  readonly server: string | null;
  /** Best-effort tool input; empty when the transcript did not carry it. */
  readonly input: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function rawMessageList(rawMessages: unknown): unknown[] {
  const record = asRecord(rawMessages);
  if (record && Array.isArray(record.data)) return record.data;
  return Array.isArray(rawMessages) ? rawMessages : [];
}

function inputOf(part: Record<string, unknown>): Record<string, unknown> {
  const state = asRecord(part.state);
  const input = state ? asRecord(state.input) : null;
  return input ?? {};
}

/**
 * Extract tool invocations from a raw `message.list` payload. Supports both the
 * direct tool parts and the code-mode `execute` wrapper (`state.metadata.toolCalls`
 * or `state.input.code`). Unknown shapes are ignored instead of guessed.
 */
export function extractToolInvocations(rawMessages: unknown): ToolInvocation[] {
  const calls: ToolInvocation[] = [];
  for (const message of rawMessageList(rawMessages)) {
    const record = asRecord(message);
    if (!record || record.type !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const partValue of content) {
      const part = asRecord(partValue);
      if (!part || part.type !== 'tool') continue;
      const name = typeof part.name === 'string' ? part.name : '';
      calls.push({ name, server: toolServerPrefix(name), input: inputOf(part) });

      const state = asRecord(part.state);
      const metadata = state ? asRecord(state.metadata) : null;
      const nested = metadata?.toolCalls;
      if (Array.isArray(nested)) {
        for (const entryValue of nested) {
          const entry = asRecord(entryValue);
          if (!entry || typeof entry.tool !== 'string') continue;
          const nestedInput = asRecord(entry.args) ?? asRecord(entry.input) ?? {};
          calls.push({
            name: entry.tool,
            server: toolServerPrefix(entry.tool),
            input: nestedInput,
          });
        }
        continue;
      }
      const input = state ? asRecord(state.input) : null;
      const code = input && typeof input.code === 'string' ? input.code : '';
      const re = /tools\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(code)) !== null) {
        const nestedName = `${match[1]}.${match[2]}`;
        calls.push({ name: nestedName, server: toolServerPrefix(nestedName), input: {} });
      }
    }
  }
  return calls;
}

function isSkillTool(call: ToolInvocation): boolean {
  return call.name === 'skill' || call.name === 'mcp.skill' || call.name.endsWith('.skill');
}

function skillIdOf(call: ToolInvocation): string | null {
  if (!isSkillTool(call)) return null;
  for (const key of ['id', 'skill', 'name']) {
    const value = call.input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isSystemInstructions(call: ToolInvocation): boolean {
  return /(^|[._])system[._]instructions$/.test(call.name);
}

export interface TranscriptAnalysis {
  /** A `skill` tool call loaded `mind-management`. */
  readonly skillLoaded: boolean;
  /** True when a raw transcript carried tool calls but no usable skill id. */
  readonly skillArgsUnavailable: boolean;
  readonly mindCalls: number;
  /** A `system_instructions` call appeared after the first skill load. */
  readonly systemInstructionsAfterSkill: boolean;
}

export function analyzeTranscripts(
  sessionResults: readonly Pick<BSessionResult, 'rawMessages'>[]
): TranscriptAnalysis {
  let skillLoaded = false;
  let sawSkillToolCall = false;
  let mindCalls = 0;
  let systemInstructionsAfterSkill = false;

  for (const session of sessionResults) {
    const calls = extractToolInvocations(session.rawMessages);
    let firstSkillIndex = -1;
    calls.forEach((call, index) => {
      if (isSkillTool(call)) sawSkillToolCall = true;
      mindCalls += call.server === 'mind' ? 1 : 0;
      if (firstSkillIndex === -1 && skillIdOf(call) === B11_SKILL_ID) {
        firstSkillIndex = index;
        skillLoaded = true;
      }
    });
    if (firstSkillIndex !== -1) {
      for (let index = firstSkillIndex + 1; index < calls.length; index += 1) {
        if (isSystemInstructions(calls[index]!)) systemInstructionsAfterSkill = true;
      }
    }
  }

  return {
    skillLoaded,
    skillArgsUnavailable: sawSkillToolCall && !skillLoaded,
    mindCalls,
    systemInstructionsAfterSkill,
  };
}

// ── Assertion ────────────────────────────────────────────────────────────────

interface ParsedCheckpoint {
  readonly name: string;
  readonly pending: string;
}

function activeCheckpoints(ctx: ScenarioAssertionContext): ParsedCheckpoint[] {
  if (!ctx.mindDb || !existsSync(ctx.mindDb)) return [];
  return inspectAllMemories(ctx.mindDb)
    .filter(memory => memory.tags.includes('checkpoint'))
    .map(memory => {
      let pending = '';
      try {
        const parsed = JSON.parse(memory.content) as { pending?: unknown };
        pending = typeof parsed.pending === 'string' ? parsed.pending : '';
      } catch {
        pending = '';
      }
      return { name: memory.name, pending };
    });
}

function carriesPendingItem(text: string): boolean {
  const folded = text.toLowerCase();
  return B11_PENDING_MARKERS.every(marker => folded.includes(marker));
}

export async function makeAssertion(
  ctx: ScenarioAssertionContext
): Promise<ScenarioAssertionResult> {
  const details: string[] = [];

  if (!ctx.mindDb || !existsSync(ctx.mindDb)) {
    return { pass: false, details: ['no Mind database available for this unit'] };
  }

  const transcripts = analyzeTranscripts(ctx.sessionResults);
  if (transcripts.skillLoaded) {
    details.push(`session 1 loaded the '${B11_SKILL_ID}' skill`);
  } else if (transcripts.skillArgsUnavailable) {
    details.push(
      `raw tool arguments were unavailable; could not prove the '${B11_SKILL_ID}' skill load`
    );
  } else {
    details.push(`session 1 did not load the '${B11_SKILL_ID}' skill`);
  }

  if (transcripts.mindCalls > 0) {
    details.push(`${transcripts.mindCalls} Mind memory/checkpoint tool call(s) observed`);
  } else {
    details.push('no Mind memory/checkpoint tool call observed');
  }

  if (transcripts.systemInstructionsAfterSkill) {
    details.push('system_instructions was called after the skill load');
  } else {
    details.push('no system_instructions call after the skill load');
  }

  const checkpoints = activeCheckpoints(ctx);
  const pendingCheckpoint = checkpoints.find(
    checkpoint => checkpoint.pending.trim().length > 0 && carriesPendingItem(checkpoint.pending)
  );
  if (pendingCheckpoint) {
    details.push(`active checkpoint '${pendingCheckpoint.name}' still carries pending work`);
  } else if (checkpoints.length > 0) {
    details.push('a checkpoint exists but its pending work does not match the checklist item');
  } else {
    details.push('no active checkpoint with pending work survived the sessions');
  }

  let artifactOk = false;
  const artifactPath = join(ctx.workspaceDir, B11_ARTIFACT_FILE);
  if (!existsSync(artifactPath)) {
    details.push(`${B11_ARTIFACT_FILE} was not written`);
  } else {
    artifactOk = carriesPendingItem(readFileSync(artifactPath, 'utf8'));
    details.push(
      artifactOk
        ? `${B11_ARTIFACT_FILE} reflects the pending release-checklist item`
        : `${B11_ARTIFACT_FILE} does not reflect the pending release-checklist item`
    );
  }

  return {
    pass:
      transcripts.skillLoaded &&
      transcripts.mindCalls > 0 &&
      !transcripts.systemInstructionsAfterSkill &&
      Boolean(pendingCheckpoint) &&
      artifactOk,
    details,
  };
}

export const B11_SCENARIO: Scenario = {
  id: 'b11',
  title: 'Skill-first activation and pending-work continuity',
  fixture: 'fixtures/b11',
  requires: ['mind-memory'],
  allowedSkills: B11_ALLOWED_SKILLS,
  seed: seedB11,
  sessions: [{ prompt: B11_PROMPTS[0]! }, { prompt: B11_PROMPTS[1]! }],
  makeAssertion,
};
