// Scenario B11 — skill-first activation and pending-work continuity.
//
// Session 1 asks the agent to record an unresolved release-checklist item and
// leave an active checkpoint with pending work. Session 2 resumes that pending
// work and writes `resume.txt`. The unit installs the canonical
// `mind-management` skill (through the real `mind setup opencode`) before any
// session, and the isolation gate allows that one skill.
//
// This scenario is PAID and gated: it declares `requires: ['mind-memory']` and
// never runs under `no-memory`. The assertion reads the raw transcripts plus the
// unit's own Mind database and the workspace artifact. It never grades the
// agent's prose.
//
// Ordering is evaluated PER SESSION over one ordered event stream (assistant
// tool parts, code-mode nested `state.metadata.toolCalls`, and `type: 'skill'`
// messages). Each session must load the exact `mind-management` skill before
// its first Mind call. A skill load in one session never covers another.
//
// LIMITATION: the harness records tool names reliably and tool arguments
// best-effort (the raw `message.list` payload). If a provider/OpenCode build
// drops `state.input`, the skill-id check cannot be proven from the transcript;
// the assertion reports that limitation instead of inventing a pass. A skill id
// inferred from the code-mode regex fallback is never accepted as a load.

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

export type TranscriptEventKind = 'tool' | 'skill';

/**
 * One entry in a session's ordered event stream. Order is the transcript's own
 * order: message order, then part order, then nested `toolCalls` array order.
 */
export interface TranscriptEvent {
  readonly kind: TranscriptEventKind;
  readonly name: string;
  readonly server: string | null;
  readonly input: Record<string, unknown>;
  /** Exact skill id carried by this event, or null when absent/unreadable. */
  readonly skillId: string | null;
  readonly source: 'part' | 'nested' | 'regex' | 'message';
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

function isSkillToolName(name: string): boolean {
  return name === 'skill' || name === 'mcp.skill' || name.endsWith('.skill');
}

/** Read a tool skill call's id. The regex fallback has empty input, so it never qualifies. */
function skillToolId(name: string, input: Record<string, unknown>): string | null {
  if (!isSkillToolName(name)) return null;
  for (const key of ['id', 'skill', 'name']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** `Session.Message.Skill` carries the id in `skill` and/or `name`. */
function skillMessageId(message: Record<string, unknown>): string | null {
  for (const key of ['skill', 'name']) {
    const value = message[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isSystemInstructions(name: string): boolean {
  return /(^|[._])system[._]instructions$/.test(name);
}

function pushToolEvent(
  events: TranscriptEvent[],
  name: string,
  input: Record<string, unknown>,
  source: TranscriptEvent['source']
): void {
  events.push({
    kind: 'tool',
    name,
    server: toolServerPrefix(name),
    input,
    skillId: skillToolId(name, input),
    source,
  });
}

/**
 * Flatten a raw `message.list` payload into ONE ordered event stream. Supports
 * direct assistant tool parts, the code-mode `state.metadata.toolCalls` array
 * (in array order), and `type: 'skill'` messages. The code-mode `state.input.code`
 * regex is a best-effort fallback: it yields event names but no arguments, so it
 * can never prove a skill load.
 */
export function extractOrderedEvents(rawMessages: unknown): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const messageValue of rawMessageList(rawMessages)) {
    const message = asRecord(messageValue);
    if (!message) continue;

    if (message.type === 'skill') {
      const skillId = skillMessageId(message);
      events.push({
        kind: 'skill',
        name: typeof message.name === 'string' ? message.name : (skillId ?? 'skill'),
        server: null,
        input: skillId ? { id: skillId } : {},
        skillId,
        source: 'message',
      });
      continue;
    }

    if (message.type !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const partValue of content) {
      const part = asRecord(partValue);
      if (!part || part.type !== 'tool') continue;
      const name = typeof part.name === 'string' ? part.name : '';
      const input = inputOf(part);
      pushToolEvent(events, name, input, 'part');

      const state = asRecord(part.state);
      const metadata = state ? asRecord(state.metadata) : null;
      const nested = metadata?.toolCalls;
      if (Array.isArray(nested)) {
        for (const entryValue of nested) {
          const entry = asRecord(entryValue);
          if (!entry || typeof entry.tool !== 'string') continue;
          const nestedInput = asRecord(entry.args) ?? asRecord(entry.input) ?? {};
          pushToolEvent(events, entry.tool, nestedInput, 'nested');
        }
        continue;
      }

      const code = input && typeof input.code === 'string' ? input.code : '';
      const re = /tools\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(code)) !== null) {
        pushToolEvent(events, `${match[1]}.${match[2]}`, {}, 'regex');
      }
    }
  }
  return events;
}

/** Tool-only projection kept for callers/tests that do not need skill messages. */
export function extractToolInvocations(rawMessages: unknown): ToolInvocation[] {
  return extractOrderedEvents(rawMessages)
    .filter(event => event.kind === 'tool')
    .map(event => ({ name: event.name, server: event.server, input: event.input }));
}

/** Per-session ordering verdict. No aggregate pass booleans are shared across sessions. */
export interface SessionTranscriptAnalysis {
  readonly sessionIndex: number;
  readonly status: BSessionResult['status'];
  readonly transcriptPresent: boolean;
  /** Event index of the first exact `mind-management` skill event, or -1. */
  readonly firstSkillIndex: number;
  /** Event index of the first Mind call (any `mind.*`, including system_instructions), or -1. */
  readonly firstMindIndex: number;
  readonly ordered: boolean;
  readonly mindCalls: number;
  /** A skill tool event carried no usable id, so its load is unproven. */
  readonly skillArgsUnavailable: boolean;
  readonly systemInstructionsAfterSkill: boolean;
  /** Explicit, human-readable reasons this session cannot pass. */
  readonly missingEvidence: readonly string[];
}

export function analyzeSession(
  session: Pick<BSessionResult, 'rawMessages' | 'status'>,
  sessionIndex: number
): SessionTranscriptAnalysis {
  const transcriptPresent = rawMessageList(session.rawMessages).length > 0;
  const events = transcriptPresent ? extractOrderedEvents(session.rawMessages) : [];
  let firstSkillIndex = -1;
  let firstMindIndex = -1;
  let mindCalls = 0;
  let skillArgsUnavailable = false;

  events.forEach((event, index) => {
    if (event.kind === 'tool' && isSkillToolName(event.name) && event.skillId === null) {
      skillArgsUnavailable = true;
    }
    if (firstSkillIndex === -1 && event.skillId === B11_SKILL_ID) {
      firstSkillIndex = index;
    }
    if (event.kind === 'tool' && event.server === 'mind') {
      mindCalls += 1;
      if (firstMindIndex === -1) firstMindIndex = index;
    }
  });

  let systemInstructionsAfterSkill = false;
  if (firstSkillIndex !== -1) {
    for (let index = firstSkillIndex + 1; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.kind === 'tool' && isSystemInstructions(event.name)) {
        systemInstructionsAfterSkill = true;
        break;
      }
    }
  }

  const ordered =
    firstSkillIndex !== -1 && firstMindIndex !== -1 && firstSkillIndex < firstMindIndex;
  const missingEvidence: string[] = [];

  if (session.status !== 'ok') {
    missingEvidence.push(`status is '${session.status}' instead of 'ok'`);
  }
  if (!transcriptPresent) {
    missingEvidence.push('transcript is empty');
  } else {
    if (firstSkillIndex === -1) {
      missingEvidence.push(
        skillArgsUnavailable
          ? `skill tool call had no usable id, so the '${B11_SKILL_ID}' load is unproven`
          : `did not load the '${B11_SKILL_ID}' skill`
      );
    }
    if (firstMindIndex === -1) {
      missingEvidence.push('made no Mind call');
    }
    if (firstSkillIndex !== -1 && firstMindIndex !== -1 && !ordered) {
      missingEvidence.push(`called Mind before loading the '${B11_SKILL_ID}' skill`);
    }
    if (systemInstructionsAfterSkill) {
      missingEvidence.push('called system_instructions after loading the skill');
    }
  }

  return {
    sessionIndex,
    status: session.status,
    transcriptPresent,
    firstSkillIndex,
    firstMindIndex,
    ordered,
    mindCalls,
    skillArgsUnavailable,
    systemInstructionsAfterSkill,
    missingEvidence,
  };
}

export function analyzeTranscripts(
  sessionResults: readonly Pick<BSessionResult, 'rawMessages' | 'status'>[]
): SessionTranscriptAnalysis[] {
  return sessionResults.map((session, index) => analyzeSession(session, index));
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

  const sessions = analyzeTranscripts(ctx.sessionResults);
  const sessionCountOk = ctx.sessionResults.length === 2;
  if (!sessionCountOk) {
    details.push(`expected exactly 2 session results, got ${ctx.sessionResults.length}`);
  }

  for (const session of sessions) {
    const label = `session ${session.sessionIndex + 1}`;
    details.push(
      [
        `${label}: status ${session.status}`,
        session.transcriptPresent ? 'transcript present' : 'transcript is empty',
        session.firstSkillIndex === -1
          ? `no '${B11_SKILL_ID}' skill event`
          : `first skill event #${session.firstSkillIndex}`,
        session.firstMindIndex === -1
          ? 'no Mind call'
          : `first Mind call #${session.firstMindIndex}`,
        session.ordered ? 'ordered' : 'not ordered',
        `${session.mindCalls} Mind call(s)`,
      ].join(', ')
    );
    for (const reason of session.missingEvidence) {
      details.push(`${label}: ${reason}`);
    }
  }

  const sessionsOk =
    sessionCountOk &&
    sessions.every(
      session =>
        session.status === 'ok' &&
        session.transcriptPresent &&
        session.mindCalls > 0 &&
        session.ordered &&
        !session.systemInstructionsAfterSkill
    );

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
  // The DB/artifact carry no session timestamps, so this proves the checkpoint
  // survived BOTH sessions; it cannot attribute creation to session 1.
  details.push(
    'checkpoint provenance: survival across both sessions (results carry no timestamps)'
  );

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
    pass: sessionsOk && Boolean(pendingCheckpoint) && artifactOk,
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
