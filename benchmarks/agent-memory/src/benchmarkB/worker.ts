#!/usr/bin/env bun
// Benchmark B child-process worker: one isolated scenario session.
//
// The parent (benchmarkB/runner.ts) spawns this once per session with a job
// file. The worker:
//   1. applies the job's isolated environment to its own process;
//   2. runs the fail-closed `verifyIsolation` gate (FREE) and writes evidence;
//   3. on contamination, aborts the session WITHOUT sending a prompt;
//   4. otherwise opens ONE new session through the real SDK driver, runs the
//      prompt to completion, captures the transcript and the child (sub-agent)
//      sessions, and writes `result.json`.
//
// Any failure is reported as a typed, structured `result.json`; the parent
// never needs to parse stderr.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand } from '../exec';
import { isolationDirs } from '../isolation/opencode';
import { ContaminationError, verifyIsolation } from '../isolation/verify';
import {
  DriverAuthError,
  DriverTimeoutError,
  buildDriverEvidence,
  createSdkDriver,
  isRunComplete,
  summarizeMessages,
  toList,
  type DriverErrorWithPartial,
  type DriverEvidence,
  type DriverIdleOutcome,
  type DriverRunResult,
} from '../opencode/driver';
import { stripRedacted } from '../redact';

import type { BSessionJob, SearchProvenanceResult } from './runner';
import type { BChildResult, BSessionOutcome, BSessionStatus } from './scenario';

function writeOutcome(sessionDir: string, outcome: BSessionOutcome): void {
  mkdirSync(sessionDir, { recursive: true });
  // Persist only the redacted projection: ordered tool/skill events survive,
  // prompts and memory contents do not.
  const persisted = { ...outcome, rawMessages: redactTranscript(outcome.rawMessages) };
  writeFileSync(join(sessionDir, 'result.json'), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
}

// ── Redacted transcript projection ───────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' ? (value as JsonRecord) : null;
}

/** Messages from either `{ data: [...] }` or a bare array; never throws. */
export function messageList(rawMessages: unknown): unknown[] {
  const record = asRecord(rawMessages);
  if (record && Array.isArray(record.data)) return record.data;
  return Array.isArray(rawMessages) ? rawMessages : [];
}

const SKILL_INPUT_KEYS = ['id', 'skill', 'name'] as const;

function isSkillToolName(name: string): boolean {
  return name === 'skill' || name === 'mcp.skill' || name.endsWith('.skill');
}

/** Keep only the keys that can prove a skill id; all other arguments are dropped. */
function sanitizeSkillInput(input: unknown): JsonRecord {
  const record = asRecord(input);
  const kept: JsonRecord = {};
  if (!record) return kept;
  for (const key of SKILL_INPUT_KEYS) {
    if (typeof record[key] === 'string') kept[key] = record[key];
  }
  return kept;
}

function sanitizeNestedToolCalls(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  const sanitized: unknown[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record || typeof record.tool !== 'string') continue;
    sanitized.push({
      tool: record.tool,
      args: isSkillToolName(record.tool) ? sanitizeSkillInput(record.args ?? record.input) : {},
    });
  }
  return sanitized;
}

/** Replace code-mode source with bare `tools.server.tool` references. */
function redactCode(code: string): string {
  const references: string[] = [];
  const pattern = /tools\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    references.push(`tools.${match[1]}.${match[2]}({})`);
  }
  return references.join('; ');
}

function redactToolPart(part: JsonRecord): JsonRecord {
  const name = typeof part.name === 'string' ? part.name : '';
  const state = asRecord(part.state) ?? {};
  const input = asRecord(state.input) ?? {};
  const isSkill = isSkillToolName(name);
  const sanitizedInput: JsonRecord = isSkill ? sanitizeSkillInput(input) : {};
  if (!isSkill && typeof input.code === 'string' && input.code.length > 0) {
    sanitizedInput.code = redactCode(input.code);
  }
  const metadata = asRecord(state.metadata);
  const nested = sanitizeNestedToolCalls(metadata?.toolCalls);
  const sanitizedState: JsonRecord = { input: sanitizedInput };
  if (nested.length > 0) sanitizedState.metadata = { toolCalls: nested };
  return {
    type: 'tool',
    name,
    state: sanitizedState,
  };
}

/**
 * Keep only the ordered evidence B11 needs: tool names, skill ids and the
 * ordering between them. Message text, tool results, prompts and memory
 * contents are dropped.
 */
export function redactTranscript(rawMessages: unknown): unknown {
  const redacted: unknown[] = [];
  for (const value of messageList(rawMessages)) {
    const message = asRecord(value);
    if (!message) continue;
    if (message.type === 'skill') {
      const skill = typeof message.skill === 'string' ? message.skill : null;
      const name = typeof message.name === 'string' ? message.name : null;
      redacted.push({ type: 'skill', ...(skill ? { skill } : {}), ...(name ? { name } : {}) });
      continue;
    }
    if (message.type !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    redacted.push({
      type: 'assistant',
      content: content.flatMap(part => {
        const record = asRecord(part);
        return record && record.type === 'tool' ? [redactToolPart(record)] : [];
      }),
    });
  }
  return { data: redacted };
}

// ── memory_query provenance (B10) ────────────────────────────────────────────

const MEMORY_QUERY_TOOL = /(^|[._])memory_query$/;

function isMemoryQueryPart(name: string, part: JsonRecord): boolean {
  if (MEMORY_QUERY_TOOL.test(name)) return true;
  const state = asRecord(part.state);
  const metadata = state ? asRecord(state.metadata) : null;
  const nested = metadata?.toolCalls;
  if (!Array.isArray(nested)) return false;
  return nested.some(entry => {
    const record = asRecord(entry);
    return (
      record !== null && typeof record.tool === 'string' && MEMORY_QUERY_TOOL.test(record.tool)
    );
  });
}

function toolResultText(part: JsonRecord): string {
  const state = asRecord(part.state) ?? {};
  const chunks: string[] = [];
  if (Array.isArray(state.content)) {
    for (const item of state.content) {
      const record = asRecord(item);
      if (record && record.type === 'text' && typeof record.text === 'string') {
        chunks.push(record.text);
      }
    }
  }
  if (typeof state.output === 'string') chunks.push(state.output);
  return chunks.join('\n');
}

function methodsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toProvenance(value: unknown): SearchProvenanceResult | null {
  const record = asRecord(value);
  if (!record || typeof record.name !== 'string' || record.name.length === 0) return null;
  return { name: record.name, methods: methodsOf(record.methods) };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function splitInlineMethods(value: string): string[] {
  return value
    .split(',')
    .map(item => stripQuotes(item))
    .filter(item => item.length > 0);
}

/** Best-effort line parser for tool outputs that are not a single YAML document. */
function parseProvenanceLines(text: string): SearchProvenanceResult[] {
  const results: SearchProvenanceResult[] = [];
  let current: { name: string; methods: string[] } | null = null;
  let insideMethods = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const nameMatch = /^(?:-\s+)?name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      if (current) results.push(current);
      current = { name: stripQuotes(nameMatch[1]!), methods: [] };
      insideMethods = false;
      continue;
    }
    if (!current) continue;
    const inlineMethods = /^methods:\s*\[(.*)\]$/.exec(line);
    if (inlineMethods) {
      current.methods.push(...splitInlineMethods(inlineMethods[1]!));
      insideMethods = false;
      continue;
    }
    if (/^methods:\s*$/.test(line)) {
      insideMethods = true;
      continue;
    }
    if (insideMethods) {
      const item = /^-\s*(.+)$/.exec(line);
      if (item) current.methods.push(stripQuotes(item[1]!));
      else insideMethods = false;
    }
  }
  if (current) results.push(current);
  return results.filter(result => result.name.length > 0);
}

function parseSearchResults(text: string): SearchProvenanceResult[] {
  const yaml = (Bun as unknown as { YAML?: { parse(input: string): unknown } }).YAML;
  if (yaml) {
    try {
      const parsed = yaml.parse(text);
      const memories = asRecord(parsed)?.memories;
      if (Array.isArray(memories)) {
        return memories
          .map(toProvenance)
          .filter((result): result is SearchProvenanceResult => result !== null);
      }
    } catch {
      // Fall through to the line parser for combined/code-mode output.
    }
  }
  return parseProvenanceLines(text);
}

/**
 * Extract only the memory name and fused `methods` from a recorded
 * `memory_query` tool result. Content and vectors are never retained.
 */
export function extractSearchProvenance(rawMessages: unknown): SearchProvenanceResult[] {
  const collected: SearchProvenanceResult[] = [];
  for (const value of messageList(rawMessages)) {
    const message = asRecord(value);
    if (!message || message.type !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const partValue of content) {
      const part = asRecord(partValue);
      if (!part || part.type !== 'tool') continue;
      const name = typeof part.name === 'string' ? part.name : '';
      if (!isMemoryQueryPart(name, part)) continue;
      const text = toolResultText(part);
      if (text.length > 0) collected.push(...parseSearchResults(text));
    }
  }
  const seen = new Set<string>();
  return collected.filter(result => {
    const key = `${result.name}\u0000${result.methods.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeChild(childId: string, raw: unknown): BChildResult {
  const summary = summarizeMessages(toList(raw), { sessionId: childId, latencyMs: 0 });
  return {
    sessionId: childId,
    finalText: summary.finalText,
    memoryCalls: summary.memoryCalls,
    toolCalls: summary.toolCalls.length,
    tokens: summary.tokens,
    costUsd: summary.costUsd,
    latencyMs: summary.latencyMs,
    steps: summary.steps,
    finish: summary.finish,
    error: summary.error ? summary.error.type : null,
  };
}

/** B outcome plus the redacted execution evidence A2/B consume. */
type BOutcomeWithEvidence = BSessionOutcome & {
  readonly idleOutcome: DriverIdleOutcome | null;
  readonly completion: 'complete' | 'incomplete';
  readonly evidence: DriverEvidence;
  readonly searchProvenance: readonly SearchProvenanceResult[];
};

/** Minimal driver surface needed to recover a failed turn's transcript. */
export interface RawMessagesSource {
  rawMessages(sessionId: string): Promise<unknown>;
}

export interface ChildCaptureResult {
  readonly children: BChildResult[];
  readonly evidence: DriverEvidence;
}

/**
 * Capture child transcripts for a parent's already-captured child ids.
 *
 * A failed child-list read (`children: 'unavailable'`) never becomes a valid
 * empty list. A failed transcript keeps the child entry but marks the evidence
 * unavailable with a reason, so B4 cannot mistake it for "no child behavior".
 */
export async function captureChildren(
  driver: RawMessagesSource,
  base: DriverEvidence
): Promise<ChildCaptureResult> {
  if (base.children === 'unavailable') return { children: [], evidence: base };
  const children: BChildResult[] = [];
  let failureReason: string | null = null;
  for (const childId of base.childSessionIds) {
    try {
      children.push(summarizeChild(childId, await driver.rawMessages(childId)));
    } catch (error) {
      failureReason = `child transcript unavailable: ${childId}: ${errorText(error)}`;
      children.push({
        sessionId: childId,
        finalText: '',
        memoryCalls: 0,
        toolCalls: 0,
        tokens: null,
        costUsd: 0,
        latencyMs: 0,
        steps: 0,
        finish: null,
        error: 'child transcript unavailable',
      });
    }
  }
  const evidence: DriverEvidence = failureReason
    ? { ...base, status: 'unavailable', reason: joinReason(base.reason, failureReason) }
    : base;
  return { children, evidence };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinReason(...parts: readonly (string | null)[]): string | null {
  const joined = parts.filter(Boolean).join('; ');
  return joined.length > 0 ? joined : null;
}

function outcomeFromResult(
  status: BSessionStatus,
  result: DriverRunResult,
  exactDriverError: string | null,
  isolationOk: boolean,
  children: readonly BChildResult[],
  rawMessages: unknown,
  evidence?: DriverEvidence
): BOutcomeWithEvidence {
  const idleOutcome = result.idleOutcome ?? null;
  return {
    status,
    sessionId: result.sessionId,
    finalText: result.finalText,
    toolCalls: result.toolCalls,
    memoryCalls: result.memoryCalls,
    model: result.model,
    tokens: result.tokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    steps: result.steps,
    finish: result.finish,
    error: exactDriverError,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    children,
    rawMessages,
    idleOutcome,
    completion: isRunComplete({ idleOutcome }) ? 'complete' : 'incomplete',
    searchProvenance: extractSearchProvenance(rawMessages),
    evidence:
      evidence ??
      result.evidence ??
      buildDriverEvidence({
        sessionId: result.sessionId,
        messages: null,
        childSessionIds: null,
        idleOutcome,
        reason: 'driver returned no evidence',
      }),
  };
}

function emptyOutcome(
  status: BSessionStatus,
  error: string | null,
  isolationOk = true
): BOutcomeWithEvidence {
  return {
    status,
    sessionId: '',
    finalText: '',
    toolCalls: [],
    memoryCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 0,
    finish: null,
    error,
    errorType: status === 'ok' ? null : status,
    isolationOk,
    children: [],
    rawMessages: { data: [] },
    idleOutcome: null,
    completion: 'incomplete',
    searchProvenance: [],
    evidence: buildDriverEvidence({
      sessionId: '',
      messages: null,
      childSessionIds: null,
      idleOutcome: null,
      reason: error ?? 'no session evidence',
    }),
  };
}

/**
 * Build the outcome for a failed session. When the driver preserved a partial
 * transcript (auth/timeout/error mid-turn) the raw messages are re-read and kept
 * so a failed session still carries evidence — never a hardcoded empty stub.
 */
export async function buildErrorOutcome(
  error: unknown,
  driver: RawMessagesSource
): Promise<BSessionOutcome> {
  const partial = (error as DriverErrorWithPartial).partial ?? null;
  const status: BSessionStatus =
    error instanceof DriverAuthError
      ? 'auth'
      : error instanceof DriverTimeoutError
        ? 'timeout'
        : 'error';
  const message = error instanceof Error ? error.message : String(error);
  if (!partial) return emptyOutcome(status, message);

  let raw: unknown = { data: [] };
  let evidence = partial.evidence;
  try {
    if (partial.sessionId) raw = await driver.rawMessages(partial.sessionId);
  } catch (error) {
    const reason = `message capture failed: ${errorText(error)}`;
    evidence = buildDriverEvidence({
      sessionId: partial.sessionId,
      messages: null,
      childSessionIds:
        partial.evidence?.children === 'captured' ? partial.evidence.childSessionIds : null,
      idleOutcome: partial.idleOutcome ?? null,
      reason,
    });
  }
  if (!evidence) {
    evidence = buildDriverEvidence({
      sessionId: partial.sessionId,
      messages: null,
      childSessionIds: null,
      idleOutcome: partial.idleOutcome ?? null,
      reason: 'partial transcript evidence unavailable',
    });
  }
  return outcomeFromResult(status, partial, message, true, [], raw, evidence);
}

async function main(): Promise<number> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.stderr.write('worker: missing job file argument\n');
    return 2;
  }
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as BSessionJob;
  mkdirSync(job.workspaceDir, { recursive: true });
  mkdirSync(job.sessionDir, { recursive: true });

  // The parent injects the isolated environment (including any credential) into
  // this process; `job.json` carries only the redacted subset, so apply just the
  // real values and never clobber an injected secret with a placeholder.
  const runtimeEnv = stripRedacted(job.env);
  for (const [key, value] of Object.entries(runtimeEnv)) process.env[key] = value;

  // 1. Fail-closed isolation gate (FREE) — no prompt until it passes.
  const dir = isolationDirs(job.conditionDir);
  try {
    await verifyIsolation({
      condition: job.condition,
      dir,
      env: runtimeEnv,
      runner: runCommand,
      evidenceDir: job.evidenceDir,
      mindBin: job.mindBin,
    });
  } catch (error) {
    if (error instanceof ContaminationError) {
      writeOutcome(job.sessionDir, emptyOutcome('contaminated', error.message, false));
      return 1;
    }
    writeOutcome(
      job.sessionDir,
      emptyOutcome('error', `isolation verify failed: ${String(error)}`)
    );
    return 1;
  }

  // 2. One new session, run to completion under limits; capture sub-sessions.
  const driver = createSdkDriver();
  try {
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    const baseEvidence =
      result.evidence ??
      buildDriverEvidence({
        sessionId: result.sessionId,
        messages: null,
        childSessionIds: result.childSessionIds ?? null,
        idleOutcome: result.idleOutcome ?? null,
        reason: 'driver returned no evidence',
      });
    const captured = await captureChildren(driver, baseEvidence);
    let raw: unknown = null;
    let evidence = captured.evidence;
    try {
      raw = await driver.rawMessages(result.sessionId);
    } catch (error) {
      const reason = `message capture failed: ${errorText(error)}`;
      evidence = {
        ...captured.evidence,
        status: 'unavailable',
        reason: joinReason(evidence.reason, reason),
      };
    }
    writeOutcome(
      job.sessionDir,
      outcomeFromResult('ok', result, null, true, captured.children, raw, evidence)
    );
    return 0;
  } catch (error) {
    writeOutcome(job.sessionDir, await buildErrorOutcome(error, driver));
    return 1;
  } finally {
    await driver.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}

export { main as runWorker };
