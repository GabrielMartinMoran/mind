// Deterministic fakes shared by the harness test suites.
//
// These keep every test fast and offline: a scripted command runner, a scripted
// OpenCode driver and an in-memory memory engine, all with the same contracts
// the real implementations will satisfy in later tasks.

import type { EngineFragment, EngineSearchResult, MemoryEngine } from '../engines/adapter';
import type { CommandInvocation, CommandResult, CommandRunner } from '../exec';
import {
  DriverAuthError,
  DriverError,
  DriverTimeoutError,
  toolServerPrefix,
  type DriverModelRef,
  type DriverRunResult,
  type DriverTokenUsage,
  type RunPromptInput,
  type SessionDriver,
} from '../opencode/driver';

export interface FakeCommandReply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export type FakeCommandResolver = (invocation: CommandInvocation) => FakeCommandReply | undefined;

export interface FakeRunner {
  readonly runner: CommandRunner;
  readonly calls: CommandInvocation[];
}

export function createFakeRunner(resolver: FakeCommandResolver = () => undefined): FakeRunner {
  const calls: CommandInvocation[] = [];
  const runner: CommandRunner = async invocation => {
    calls.push(invocation);
    const reply = resolver(invocation) ?? {};
    return {
      command: invocation.command,
      args: invocation.args,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    } satisfies CommandResult;
  };
  return { runner, calls };
}

// ── Fake OpenCode driver (used from T4 onward) ───────────────────────────────

export interface DriverReply {
  readonly text: string;
  readonly cost?: number;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly error?: string;
}

export interface RecordedSession {
  readonly id: string;
  readonly prompts: string[];
}

export interface FakeOpenCodeDriver {
  readonly sessions: RecordedSession[];
  readonly sentPrompts: { readonly sessionID: string; readonly text: string }[];
  script(reply: DriverReply): void;
  createSession(): RecordedSession;
  prompt(sessionID: string, text: string): Promise<DriverReply>;
}

export function createFakeOpenCodeDriver(): FakeOpenCodeDriver {
  const sessions: RecordedSession[] = [];
  const sentPrompts: { sessionID: string; text: string }[] = [];
  const replies: DriverReply[] = [];
  let counter = 0;

  return {
    sessions,
    sentPrompts,
    script(reply: DriverReply): void {
      replies.push(reply);
    },
    createSession(): RecordedSession {
      const session: RecordedSession = { id: `ses_fake_${counter++}`, prompts: [] };
      sessions.push(session);
      return session;
    },
    async prompt(sessionID: string, text: string): Promise<DriverReply> {
      const session = sessions.find(s => s.id === sessionID);
      if (!session) throw new Error(`unknown session: ${sessionID}`);
      session.prompts.push(text);
      sentPrompts.push({ sessionID, text });
      return replies.shift() ?? { text: 'ok', cost: 0 };
    },
  };
}

// ── Fake SessionDriver (used by A2 dry-runs and judge tests) ─────────────────

export interface FakeSessionScript {
  readonly text?: string;
  readonly cost?: number;
  readonly tokens?: Partial<DriverTokenUsage>;
  readonly toolNames?: readonly string[];
  readonly model?: DriverModelRef;
  readonly finish?: string;
  readonly steps?: number;
  readonly latencyMs?: number;
  /** Reject with a typed driver error instead of resolving. */
  readonly errorKind?: 'auth' | 'timeout' | 'error';
  readonly errorMessage?: string;
  readonly children?: readonly string[];
}

export interface FakeSessionDriver extends SessionDriver {
  readonly prompts: readonly RunPromptInput[];
}

function toTokenUsage(partial: Partial<DriverTokenUsage> | undefined): DriverTokenUsage | null {
  if (!partial) return null;
  return {
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    reasoning: partial.reasoning ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
  };
}

export function createFakeSessionDriver(
  script: readonly FakeSessionScript[] = []
): FakeSessionDriver {
  const queue = [...script];
  const prompts: RunPromptInput[] = [];
  const childrenBySession = new Map<string, readonly string[]>();
  let counter = 0;

  const nextScript = (): FakeSessionScript => queue.shift() ?? { text: 'ok' };

  return {
    prompts,
    async runPrompt(input: RunPromptInput): Promise<DriverRunResult> {
      prompts.push(input);
      const step = nextScript();
      if (step.errorKind) {
        const info = {
          type: step.errorKind === 'auth' ? 'provider.auth' : 'error',
          message: step.errorMessage ?? step.errorKind,
          status: step.errorKind === 'auth' ? 401 : null,
          code: step.errorKind === 'auth' ? 'api_key_expired' : null,
        };
        if (step.errorKind === 'auth') throw new DriverAuthError(info.message, info);
        if (step.errorKind === 'timeout') throw new DriverTimeoutError(info.message, info);
        throw new DriverError(info.message, info);
      }
      const sessionId = `ses_fake_${counter++}`;
      const toolCalls = (step.toolNames ?? []).map((name, index) => ({
        id: `tool_${index}`,
        name,
        server: toolServerPrefix(name),
      }));
      const text = step.text ?? 'ok';
      childrenBySession.set(sessionId, step.children ?? []);
      return {
        sessionId,
        finalText: text,
        assistantTexts: [text],
        toolCalls,
        memoryCalls: toolCalls.filter(call => call.server === 'mind').length,
        model: step.model ?? {
          providerID: 'opencode-go',
          id: 'deepseek-v4.1-flash',
          variant: 'default',
        },
        costUsd: step.cost ?? 0,
        tokens: toTokenUsage(step.tokens),
        steps: step.steps ?? 1,
        latencyMs: step.latencyMs ?? 1,
        finish: step.finish ?? 'stop',
        error: null,
      };
    },
    async children(sessionId: string): Promise<readonly string[]> {
      return childrenBySession.get(sessionId) ?? [];
    },
    async rawMessages(): Promise<unknown> {
      return { data: [] };
    },
    async close(): Promise<void> {
      // no-op
    },
  };
}

// ── In-memory memory engine (used for contract tests and dry-runs) ───────────
export function createFakeEngine(overrides: Partial<MemoryEngine> = {}): MemoryEngine {
  const stores = new Map<string, EngineFragment[]>();
  const base: MemoryEngine = {
    id: 'fake',
    async reset(runKey: string): Promise<void> {
      stores.set(runKey, []);
    },
    async insert(_userKey: string, text: string): Promise<number> {
      const store = stores.get(_userKey) ?? [];
      store.push({ text, score: 0 });
      stores.set(_userKey, store);
      return 0;
    },
    async flush(): Promise<void> {
      // no-op for the fake
    },
    async search(userKey: string, query: string, k: number): Promise<EngineSearchResult> {
      const store = stores.get(userKey) ?? [];
      const chunks = store.filter(f => f.text.includes(query)).slice(0, k);
      return { chunks, latencyMs: 0, nativeScoreKind: 'unknown' };
    },
    async cleanup(runKey: string): Promise<void> {
      stores.delete(runKey);
    },
  };
  return { ...base, ...overrides };
}
