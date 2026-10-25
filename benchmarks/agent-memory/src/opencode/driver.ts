// OpenCode session driver: the injectable seam that runs ONE prompt in an
// already-prepared isolated environment and returns a structured result.
//
// Two implementations exist:
//   - `createSdkDriver()` — the real one, using the official `@opencode/sdk`
//     in-process host (T1 pattern). The model is pinned EXPLICITLY on
//     `sessions.create` because the SDK ignores the config `model`.
//   - a fake one used by tests/dry-runs (see `testing/fakes.ts`).
//
// All the pure helpers (tool-call counting, error classification) live here so
// they can be unit-tested against synthetic message dumps without any network.

import { join } from 'node:path';

import { MODEL, type ModelRef } from '../config';

export interface SessionLimits {
  /** Maximum agent steps (messages) per session. */
  readonly steps: number;
  /** Per-invocation wall-clock timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** A normalized assistant tool call extracted from a message dump. */
export interface DriverToolCall {
  readonly id: string;
  readonly name: string;
  /** Server prefix before the first `_`/`.` (e.g. `mind` for `mind_memory_query`). */
  readonly server: string | null;
}

export interface DriverTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface DriverModelRef {
  readonly providerID: string | null;
  readonly id: string | null;
  readonly variant: string | null;
}

/** Terminal outcome recorded by OpenCode when a run reaches idle. */
export type DriverIdleOutcome = 'succeeded' | 'failed' | 'interrupted';

/** Whether one evidence read succeeded or was unavailable. */
export type DriverCaptureStatus = 'captured' | 'unavailable';

/** A redacted tool event: the tool name and its server prefix only. */
export interface DriverToolEvent {
  readonly name: string;
  readonly server: string | null;
}

/**
 * Minimal, redacted execution evidence. It never carries prompts, memory
 * contents, credentials, tool arguments, or transcript text.
 */
export interface DriverEvidence {
  /** `captured` only when the message and child reads both succeeded. */
  readonly status: DriverCaptureStatus;
  readonly reason: string | null;
  readonly messages: DriverCaptureStatus;
  readonly children: DriverCaptureStatus;
  readonly idle: DriverCaptureStatus;
  readonly sessionId: string;
  readonly childSessionIds: readonly string[];
  readonly tools: readonly DriverToolEvent[];
  readonly skillIds: readonly string[];
  readonly assistantFinish: string | null;
  readonly idleOutcome: DriverIdleOutcome | null;
}

export interface DriverEvidenceInput {
  readonly sessionId: string;
  /** `null` means the message read failed; `[]` is a valid empty transcript. */
  readonly messages: readonly unknown[] | null;
  /** `null` means the child-list read failed; `[]` is a valid no-child result. */
  readonly childSessionIds: readonly string[] | null;
  readonly idleOutcome: DriverIdleOutcome | null;
  readonly reason?: string | null;
}

/** A minimal, provider-agnostic view of the assistant turn(s). */
export interface DriverRunResult {
  readonly sessionId: string;
  readonly finalText: string;
  readonly assistantTexts: readonly string[];
  readonly toolCalls: readonly DriverToolCall[];
  /** Tool calls whose server prefix is `mind`. */
  readonly memoryCalls: number;
  readonly model: DriverModelRef | null;
  readonly costUsd: number;
  readonly tokens: DriverTokenUsage | null;
  /** Number of assistant messages observed (proxy for steps). */
  readonly steps: number;
  readonly latencyMs: number;
  readonly finish: string | null;
  readonly error: DriverErrorInfo | null;
  /** Session idle outcome; absent means completion is unknown. */
  readonly idleOutcome?: DriverIdleOutcome | null;
  /** Ordered child (sub-agent) session ids. */
  readonly childSessionIds?: readonly string[];
  /** Redacted capture evidence, or explicit unavailability. */
  readonly evidence?: DriverEvidence;
}

export interface DriverErrorInfo {
  readonly type: string;
  readonly message: string;
  readonly status: number | null;
  readonly code: string | null;
}

/** Everything the driver needs to start one isolated session. */
export interface RunPromptInput {
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly limits: SessionLimits;
  /** Overrides the pinned model (used by tests); defaults to `MODEL`. */
  readonly model?: ModelRef;
}

/**
 * Injectable driver. `rawMessages` and `children` are best-effort and only
 * required by callers that need the full transcript / sub-sessions.
 */
export interface SessionDriver {
  runPrompt(input: RunPromptInput): Promise<DriverRunResult>;
  children(sessionId: string): Promise<readonly string[]>;
  rawMessages(sessionId: string): Promise<unknown>;
  close(): Promise<void>;
}

// ── Typed errors ─────────────────────────────────────────────────────────────

export class DriverError extends Error {
  constructor(
    message: string,
    public readonly info: DriverErrorInfo
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

export class DriverAuthError extends DriverError {
  constructor(message: string, info: DriverErrorInfo) {
    super(message, info);
    this.name = 'DriverAuthError';
  }
}

export class DriverTimeoutError extends DriverError {
  constructor(message: string, info: DriverErrorInfo) {
    super(message, info);
    this.name = 'DriverTimeoutError';
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export const MIND_SERVER_PREFIX = 'mind';

interface RawAssistantContent {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly state?: unknown;
}

interface RawMessage {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly model?: unknown;
  readonly cost?: unknown;
  readonly tokens?: unknown;
  readonly finish?: unknown;
  readonly error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Server prefix of a tool name: `mind_memory_query` -> `mind`. */
export function toolServerPrefix(name: string): string | null {
  const match = /^([a-zA-Z0-9]+)[._]/.exec(name);
  return match ? match[1]! : null;
}

export function isMemoryTool(name: string): boolean {
  return toolServerPrefix(name) === MIND_SERVER_PREFIX;
}

/**
 * Nested tool names invoked by the code-mode `execute` tool.
 *
 * OpenCode 2.0.28 exposes MCP tools through a single `execute` tool whose
 * `state.metadata.toolCalls` (or `state.input.code`) records the real server
 * tool, e.g. `mind.status`. Without unwrapping this, an actual Mind call would
 * be invisible to the metrics.
 */
export function nestedToolNames(part: RawAssistantContent | null): string[] {
  const state = part ? asRecord(part.state) : null;
  if (!state) return [];
  const names: string[] = [];
  const metadata = asRecord(state.metadata);
  const listed = metadata?.toolCalls;
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const rec = asRecord(entry);
      if (rec && typeof rec.tool === 'string' && rec.tool.length > 0) names.push(rec.tool);
    }
  }
  if (names.length === 0) {
    const input = asRecord(state.input);
    const code = input && typeof input.code === 'string' ? input.code : '';
    const re = /tools\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) names.push(`${match[1]}.${match[2]}`);
  }
  return names;
}

/** Extract tool calls from a raw message array; memory calls use the `mind` prefix. */
export function extractToolCalls(messages: readonly unknown[]): DriverToolCall[] {
  const calls: DriverToolCall[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.type !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      const contentPart = asRecord(part) as RawAssistantContent | null;
      if (!contentPart || contentPart.type !== 'tool') continue;
      const name = typeof contentPart.name === 'string' ? contentPart.name : '';
      calls.push({
        id: typeof contentPart.id === 'string' ? contentPart.id : '',
        name,
        server: toolServerPrefix(name),
      });
      // Unwrap code-mode nested calls (e.g. `execute` -> `mind.status`).
      for (const nested of nestedToolNames(contentPart)) {
        calls.push({ id: '', name: nested, server: toolServerPrefix(nested) });
      }
    }
  }
  return calls;
}

export function countMemoryCalls(messages: readonly unknown[]): number {
  return extractToolCalls(messages).filter(call => call.server === MIND_SERVER_PREFIX).length;
}

/** Normalize the SDK `outcome` field; anything unexpected means unknown. */
export function normalizeIdleOutcome(value: unknown): DriverIdleOutcome | null {
  return value === 'succeeded' || value === 'failed' || value === 'interrupted' ? value : null;
}

/** Ordered skill ids activated in the session (`type: 'skill'` messages). */
export function extractSkillIds(messages: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.type !== 'skill') continue;
    const id = record.skill;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

function lastAssistantFinish(messages: readonly unknown[]): string | null {
  let finish: string | null = null;
  for (const message of messages) {
    const record = asRecord(message);
    if (!record || record.type !== 'assistant') continue;
    finish = typeof record.finish === 'string' ? record.finish : null;
  }
  return finish;
}

/**
 * Build minimal redacted evidence from reads that may have failed. A failed
 * read is `unavailable`; it is never converted into valid empty evidence.
 */
export function buildDriverEvidence(input: DriverEvidenceInput): DriverEvidence {
  const messagesCaptured = input.messages !== null;
  const childrenCaptured = input.childSessionIds !== null;
  const idleCaptured = input.idleOutcome !== null;
  const tools = messagesCaptured
    ? extractToolCalls(input.messages!).map(call => ({ name: call.name, server: call.server }))
    : [];
  const status: DriverCaptureStatus =
    messagesCaptured && childrenCaptured ? 'captured' : 'unavailable';
  const reasons: string[] = [];
  if (!messagesCaptured) reasons.push('message capture failed');
  if (!childrenCaptured) reasons.push('child capture failed');
  const reason = input.reason ?? (reasons.length > 0 ? reasons.join('; ') : null);

  return {
    status,
    reason,
    messages: messagesCaptured ? 'captured' : 'unavailable',
    children: childrenCaptured ? 'captured' : 'unavailable',
    idle: idleCaptured ? 'captured' : 'unavailable',
    sessionId: input.sessionId,
    childSessionIds: input.childSessionIds ?? [],
    tools,
    skillIds: messagesCaptured ? extractSkillIds(input.messages!) : [],
    assistantFinish: messagesCaptured ? lastAssistantFinish(input.messages!) : null,
    idleOutcome: input.idleOutcome,
  };
}

/**
 * Completion requires a successful session idle outcome. A resolved `wait`
 * (204) or a per-message `finish: "tool-calls"` is not proof of completion.
 */
export function isRunComplete(result: { idleOutcome?: DriverIdleOutcome | null }): boolean {
  return result.idleOutcome === 'succeeded';
}

function extractAssistantTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    const record = asRecord(message) as RawMessage | null;
    if (!record || record.type !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content
      .map(part => asRecord(part) as RawAssistantContent | null)
      .filter((part): part is RawAssistantContent => part?.type === 'text')
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (text) texts.push(text);
  }
  return texts;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function extractTokenUsage(value: unknown): DriverTokenUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const cache = asRecord(record.cache);
  return {
    input: num(record.input),
    output: num(record.output),
    reasoning: num(record.reasoning),
    cacheRead: cache ? num(cache.read) : 0,
    cacheWrite: cache ? num(cache.write) : 0,
  };
}

/** Sum token usage across every assistant message. */
function sumAssistantTokens(assistants: readonly unknown[]): DriverTokenUsage | null {
  let seen = false;
  const total = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const message of assistants) {
    const usage = extractTokenUsage((message as RawMessage).tokens);
    if (!usage) continue;
    seen = true;
    total.input += usage.input;
    total.output += usage.output;
    total.reasoning += usage.reasoning;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
  }
  return seen ? total : null;
}

function extractModel(value: unknown): DriverModelRef | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    providerID: typeof record.providerID === 'string' ? record.providerID : null,
    id: typeof record.id === 'string' ? record.id : null,
    variant: typeof record.variant === 'string' ? record.variant : null,
  };
}

/**
 * Build a normalized result from a raw `message.list` payload (array or
 * `{ data: [...] }`). Pure: takes the raw list and timing, returns a
 * `DriverRunResult` with empty `sessionId` filled by the caller.
 */
export function summarizeMessages(
  rawList: readonly unknown[],
  options: { sessionId: string; latencyMs: number }
): DriverRunResult {
  const assistants = rawList.filter(message => asRecord(message)?.type === 'assistant');
  const last = asRecord(assistants[assistants.length - 1] ?? null) as RawMessage | null;
  const assistantTexts = extractAssistantTexts(rawList);
  const toolCalls = extractToolCalls(rawList);
  const tokens = sumAssistantTokens(assistants);
  const cost = assistants.reduce<number>((sum, message) => sum + num(asRecord(message)?.cost), 0);
  const errorInfo = last ? normalizeStructuredError(last.error) : null;

  return {
    sessionId: options.sessionId,
    finalText: assistantTexts[assistantTexts.length - 1] ?? '',
    assistantTexts,
    toolCalls,
    memoryCalls: toolCalls.filter(call => call.server === MIND_SERVER_PREFIX).length,
    model: last ? extractModel(last.model) : null,
    costUsd: cost,
    tokens,
    steps: assistants.length,
    latencyMs: options.latencyMs,
    finish: last && typeof last.finish === 'string' ? last.finish : null,
    error: errorInfo,
  };
}

export function normalizeStructuredError(value: unknown): DriverErrorInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  let code: string | null = null;
  const response = asRecord(record.response);
  if (response && typeof response.body === 'string') {
    code = extractBodyCode(response.body);
  }
  return {
    type: typeof record.type === 'string' ? record.type : 'unknown',
    message: typeof record.message === 'string' ? record.message : '',
    status: typeof record.status === 'number' ? record.status : null,
    code,
  };
}

function extractBodyCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const error = asRecord(asRecord(parsed)?.error);
    return error && typeof error.code === 'string' ? error.code : null;
  } catch {
    return null;
  }
}

/** Auth-expiry detection: status 401, `api_key_expired`, or an auth error type. */
export function isAuthError(info: DriverErrorInfo | null | undefined): boolean {
  if (!info) return false;
  if (info.status === 401) return true;
  if (info.code === 'api_key_expired') return true;
  if (info.type.startsWith('provider.auth')) return true;
  return /api[_-]?key[_-]?expired|authentication_error|unauthorized/i.test(
    `${info.type} ${info.message} ${info.code ?? ''}`
  );
}

/** Classify any thrown value into a typed driver error. */
export function classifyDriverError(error: unknown): DriverError {
  if (error instanceof DriverError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const info: DriverErrorInfo = {
    type: 'error',
    message: message.slice(0, 1000),
    status: extractStatus(message),
    code: extractBodyCode(message) ?? extractCode(message),
  };
  if (isAuthError(info)) return new DriverAuthError(message, info);
  if (/timed out|timeout/i.test(message)) return new DriverTimeoutError(message, info);
  return new DriverError(message, info);
}

function extractStatus(text: string): number | null {
  const match = /"status"\s*:\s*(\d{3})|\bstatus[:= ]\s*(\d{3})\b/.exec(text);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  return raw ? Number(raw) : null;
}

function extractCode(text: string): string | null {
  const match = /"(?:code|type)"\s*:\s*"([^"]+)"/.exec(text);
  return match ? match[1]! : null;
}

// ── Real SDK driver ──────────────────────────────────────────────────────────

/** Minimal structural view of the SDK instance the driver relies on. */
interface SdkSession {
  readonly id: string;
}
interface SdkSessionInfo {
  readonly id?: string;
  readonly parentID?: string;
  readonly outcome?: unknown;
  readonly time?: { readonly idle?: unknown };
}

interface SdkInstance {
  readonly sessions: {
    create(input: {
      location: { directory: string };
      model: { id: string; providerID: string; variant?: string };
    }): Promise<SdkSession>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<SdkSessionInfo>;
    list(input?: { parentID?: string }): Promise<{ data?: SdkSessionInfo[] } | SdkSessionInfo[]>;
  };
  readonly message: {
    list(input: { sessionID: string }): Promise<unknown>;
  };
  readonly close?: () => Promise<void>;
  readonly [Symbol.asyncDispose]?: () => Promise<void>;
}

export interface SdkDriverOptions {
  /** Environment for the embedded host (defaults to `process.env`). */
  readonly env?: Record<string, string | undefined>;
  /** Explicit per-unit database file; falls back to `OPENCODE_DB`. */
  readonly databasePath?: string;
  /** Injectable for tests: bypasses the real `@opencode/sdk` import. */
  readonly createInstance?: () => Promise<SdkInstance>;
}

export interface HostCreateOptions {
  readonly config?: { readonly content?: string; readonly directory?: string };
  readonly database?: { readonly path: string };
}

/**
 * Options for the embedded SDK host. Unlike the CLI, the in-process host does
 * NOT read `OPENCODE_CONFIG_CONTENT` on its own — it must be handed the inline
 * config explicitly via `config.content` (and the config directory), otherwise
 * the pinned MCP servers are never registered (observed on SDK 2.0.28).
 *
 * The embedded host also ignores the `OPENCODE_DB` environment variable and
 * defaults to `:memory:`, so the isolated database path must be passed
 * explicitly through `database.path`.
 */
export function hostCreateOptions(
  env: Record<string, string | undefined> = process.env,
  databasePath?: string
): HostCreateOptions | undefined {
  const content = env.OPENCODE_CONFIG_CONTENT;
  const configHome = env.XDG_CONFIG_HOME;
  const config: { content?: string; directory?: string } = {};
  if (content) config.content = content;
  if (configHome) config.directory = join(configHome, 'opencode');
  const path = databasePath ?? env.OPENCODE_DB;
  const hasConfig = Object.keys(config).length > 0;
  if (!hasConfig && !path) return undefined;
  const options: {
    config?: { content?: string; directory?: string };
    database?: { path: string };
  } = {};
  if (hasConfig) options.config = config;
  if (path) options.database = { path };
  return options;
}

async function defaultCreateInstance(
  env: Record<string, string | undefined>,
  databasePath?: string
): Promise<SdkInstance> {
  const sdk = (await import('@opencode/sdk')) as {
    OpenCode: { create: (options?: unknown) => Promise<SdkInstance> };
  };
  return sdk.OpenCode.create(hostCreateOptions(env, databasePath));
}

function variantFor(model: ModelRef): string | undefined {
  return model.variant && model.variant !== 'default' ? model.variant : undefined;
}

export function toList(raw: unknown): unknown[] {
  const record = asRecord(raw);
  const data = record?.data;
  if (Array.isArray(data)) return data;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Real driver over the official SDK. The host reads `process.env`, so the
 * caller (the per-unit worker) sets the isolated environment before creating
 * the driver; `options.env` is applied defensively too.
 */
export function createSdkDriver(options: SdkDriverOptions = {}): SessionDriver {
  const applyEnv = (): void => {
    if (!options.env) return;
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) process.env[key] = value;
    }
  };
  const resolveEnv = (): Record<string, string | undefined> => options.env ?? process.env;
  let instance: SdkInstance | null = null;

  // One host per driver, kept alive through prompt and evidence capture. The
  // embedded host's database is bound explicitly so a later host (or the same
  // host after idle) reads the unit's own file, never `:memory:`.
  const openInstance = async (): Promise<SdkInstance> => {
    if (instance) return instance;
    applyEnv();
    instance = options.createInstance
      ? await options.createInstance()
      : await defaultCreateInstance(resolveEnv(), options.databasePath);
    return instance;
  };

  const readMessages = async (
    host: SdkInstance,
    sessionId: string
  ): Promise<{ messages: unknown[] | null; reason: string | null }> => {
    try {
      return { messages: toList(await host.message.list({ sessionID: sessionId })), reason: null };
    } catch (error) {
      return { messages: null, reason: `message capture failed: ${errorText(error)}` };
    }
  };

  const readChildren = async (
    host: SdkInstance,
    sessionId: string
  ): Promise<{ ids: string[] | null; reason: string | null }> => {
    try {
      const list = toList(await host.sessions.list({ parentID: sessionId }));
      return {
        ids: list
          .map(entry => (asRecord(entry)?.id as string | undefined) ?? null)
          .filter((id): id is string => typeof id === 'string'),
        reason: null,
      };
    } catch (error) {
      return { ids: null, reason: `child capture failed: ${errorText(error)}` };
    }
  };

  const readIdleOutcome = async (
    host: SdkInstance,
    sessionId: string
  ): Promise<{ outcome: DriverIdleOutcome | null; reason: string | null }> => {
    try {
      const info = asRecord(await host.sessions.get({ sessionID: sessionId }));
      return { outcome: normalizeIdleOutcome(info?.outcome), reason: null };
    } catch (error) {
      return { outcome: null, reason: `idle outcome capture failed: ${errorText(error)}` };
    }
  };

  const capture = async (
    host: SdkInstance,
    sessionId: string
  ): Promise<{
    messages: unknown[] | null;
    childSessionIds: string[] | null;
    idleOutcome: DriverIdleOutcome | null;
    evidence: DriverEvidence;
  }> => {
    const messages = await readMessages(host, sessionId);
    const children = await readChildren(host, sessionId);
    const idle = await readIdleOutcome(host, sessionId);
    const reason =
      [messages.reason, children.reason, idle.reason].filter(Boolean).join('; ') || null;
    const evidence = buildDriverEvidence({
      sessionId,
      messages: messages.messages,
      childSessionIds: children.ids,
      idleOutcome: idle.outcome,
      reason,
    });
    return {
      messages: messages.messages,
      childSessionIds: children.ids,
      idleOutcome: idle.outcome,
      evidence,
    };
  };

  const closeInstance = async (): Promise<void> => {
    if (!instance) return;
    const current = instance;
    instance = null;
    if (current.close) await current.close().catch(() => undefined);
    else {
      const dispose = current[Symbol.asyncDispose];
      if (dispose) await dispose().catch(() => undefined);
    }
  };

  return {
    async runPrompt(input: RunPromptInput): Promise<DriverRunResult> {
      const model = input.model ?? MODEL;
      const host = await openInstance();
      const started = Date.now();
      let sessionId = '';
      try {
        const session = await host.sessions.create({
          location: { directory: input.workspaceDir },
          model: {
            id: model.id,
            providerID: model.providerID,
            ...variantFields(variantFor(model)),
          },
        });
        sessionId = session.id;
        await host.sessions.prompt({ sessionID: session.id, text: input.prompt });
        await withTimeout(
          host.sessions.wait({ sessionID: session.id }),
          input.limits.timeoutMs,
          `session ${session.id}`
        );
        const captured = await capture(host, session.id);
        const result: DriverRunResult = {
          ...summarizeMessages(captured.messages ?? [], {
            sessionId: session.id,
            latencyMs: Date.now() - started,
          }),
          idleOutcome: captured.idleOutcome,
          childSessionIds: captured.childSessionIds ?? [],
          evidence: captured.evidence,
        };
        throwIfTerminalDriverError(result);
        return result;
      } catch (error) {
        const classified = classifyDriverError(error);
        // Preserve whatever evidence exists so the caller can still classify it.
        const captured = sessionId
          ? await capture(host, sessionId)
          : {
              messages: null,
              childSessionIds: null,
              idleOutcome: null,
              evidence: buildDriverEvidence({
                sessionId,
                messages: null,
                childSessionIds: null,
                idleOutcome: null,
                reason: 'session was not created',
              }),
            };
        const result: DriverRunResult = {
          ...summarizeMessages(captured.messages ?? [], {
            sessionId,
            latencyMs: Date.now() - started,
          }),
          idleOutcome: captured.idleOutcome,
          childSessionIds: captured.childSessionIds ?? [],
          evidence: captured.evidence,
        };
        const info = classified.info;
        throw createTypedError(classified, info, result);
      }
    },

    async children(sessionId: string): Promise<readonly string[]> {
      const host = await openInstance();
      const list = toList(await host.sessions.list({ parentID: sessionId }));
      return list
        .map(entry => (asRecord(entry)?.id as string | undefined) ?? null)
        .filter((id): id is string => typeof id === 'string');
    },

    async rawMessages(sessionId: string): Promise<unknown> {
      const host = await openInstance();
      return await host.message.list({ sessionID: sessionId });
    },

    async close(): Promise<void> {
      await closeInstance();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function variantFields(variant: string | undefined): { variant?: string } {
  return variant ? { variant } : {};
}

// The transcript captured before a failed turn is attached to the typed error
// so an auth failure still yields a structured, persistable outcome.
export interface DriverErrorWithPartial extends DriverError {
  partial?: DriverRunResult;
}

function createTypedError(
  classified: DriverError,
  info: DriverErrorInfo,
  partial: DriverRunResult
): DriverError {
  const message = classified.message;
  const error =
    classified instanceof DriverAuthError
      ? new DriverAuthError(message, info)
      : classified instanceof DriverTimeoutError
        ? new DriverTimeoutError(message, info)
        : new DriverError(message, info);
  (error as DriverErrorWithPartial).partial = partial;
  return error;
}

/**
 * A turn can finish "successfully" while its last assistant message carries a
 * terminal provider error (e.g. an expired key returns `finish: "error"` with a
 * `provider.auth` body rather than rejecting the wait). Promote auth/timeout
 * transcript errors to the typed errors the worker already handles, so an auth
 * failure is never silently scored as an empty answer.
 */
function throwIfTerminalDriverError(result: DriverRunResult): void {
  const info = result.error;
  if (!info) return;
  if (isAuthError(info)) {
    throw createTypedError(new DriverAuthError(info.message, info), info, result);
  }
  if (/timed out|timeout/i.test(`${info.type} ${info.message}`)) {
    throw createTypedError(new DriverTimeoutError(info.message, info), info, result);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
