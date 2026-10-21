import { describe, expect, test } from 'bun:test';

import {
  DriverAuthError,
  DriverError,
  DriverTimeoutError,
  classifyDriverError,
  countMemoryCalls,
  createSdkDriver,
  extractToolCalls,
  isAuthError,
  isMemoryTool,
  nestedToolNames,
  normalizeStructuredError,
  summarizeMessages,
  toolServerPrefix,
} from '../src/opencode/driver';

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    content: [],
    model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'stop',
    ...overrides,
  };
}

describe('tool name parsing', () => {
  test('toolServerPrefix extracts the server prefix', () => {
    expect(toolServerPrefix('mind_memory_query')).toBe('mind');
    expect(toolServerPrefix('mind.memory.query')).toBe('mind');
    expect(toolServerPrefix('read')).toBeNull();
  });

  test('isMemoryTool only matches the mind server', () => {
    expect(isMemoryTool('mind_memory_query')).toBe(true);
    expect(isMemoryTool('mindful_thing')).toBe(false);
    expect(isMemoryTool('bash')).toBe(false);
  });
});

describe('extractToolCalls / countMemoryCalls', () => {
  const messages = [
    { type: 'user', content: [{ type: 'text', text: 'hi' }] },
    assistant({
      content: [
        { type: 'text', text: 'searching' },
        { type: 'tool', id: 't1', name: 'mind_memory_query' },
        { type: 'tool', id: 't2', name: 'bash' },
      ],
    }),
    assistant({ content: [{ type: 'tool', id: 't3', name: 'mind_memory_read' }] }),
  ];

  test('extracts every tool call with its server', () => {
    const calls = extractToolCalls(messages);
    expect(calls.map(c => c.name)).toEqual(['mind_memory_query', 'bash', 'mind_memory_read']);
    expect(calls.map(c => c.server)).toEqual(['mind', null, 'mind']);
  });

  test('counts only mind-prefixed calls as memory calls', () => {
    expect(countMemoryCalls(messages)).toBe(2);
  });

  test('ignores non-assistant messages', () => {
    expect(countMemoryCalls([{ type: 'user', content: [{ type: 'tool', name: 'mind_x' }] }])).toBe(
      0
    );
  });

  test('unwraps code-mode mind calls nested in the execute tool', () => {
    const codeMode = [
      assistant({
        content: [
          {
            type: 'tool',
            id: 'e1',
            name: 'execute',
            state: {
              status: 'completed',
              input: { code: 'const r = await tools.mind.status({});\nreturn r;' },
              metadata: { toolCalls: [{ tool: 'mind.status', status: 'completed' }] },
            },
          },
        ],
      }),
    ];
    const calls = extractToolCalls(codeMode);
    expect(calls.map(c => c.name)).toEqual(['execute', 'mind.status']);
    expect(countMemoryCalls(codeMode)).toBe(1);
    expect(nestedToolNames({ type: 'tool', name: 'execute', state: undefined })).toEqual([]);
  });
});

describe('summarizeMessages', () => {
  test('aggregates cost, tokens, model, finish and memory calls', () => {
    const messages = [
      assistant({
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool', id: 't1', name: 'mind_memory_query' },
        ],
        cost: 0.0012,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 2 } },
      }),
      assistant({ content: [{ type: 'text', text: 'final answer' }], cost: 0.0008 }),
    ];
    const result = summarizeMessages(messages, { sessionId: 'ses_1', latencyMs: 42 });

    expect(result.sessionId).toBe('ses_1');
    expect(result.finalText).toBe('final answer');
    expect(result.assistantTexts).toEqual(['first', 'final answer']);
    expect(result.memoryCalls).toBe(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.steps).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.002, 6);
    expect(result.tokens?.input).toBe(10);
    expect(result.tokens?.cacheWrite).toBe(2);
    expect(result.model).toEqual({
      providerID: 'opencode-go',
      id: 'deepseek-v4.1-flash',
      variant: 'default',
    });
    expect(result.finish).toBe('stop');
    expect(result.latencyMs).toBe(42);
  });

  test('handles an empty transcript', () => {
    const result = summarizeMessages([], { sessionId: 'ses_x', latencyMs: 0 });
    expect(result.finalText).toBe('');
    expect(result.model).toBeNull();
    expect(result.tokens).toBeNull();
    expect(result.error).toBeNull();
    expect(result.memoryCalls).toBe(0);
  });
});

describe('error classification', () => {
  test('normalizes the real 401 api_key_expired shape from the T1 evidence', () => {
    const info = normalizeStructuredError({
      type: 'provider.auth',
      message: 'This API key has expired.',
      status: 401,
      response: {
        body: '{"error":{"type":"authentication_error","code":"api_key_expired","message":"x"}}',
      },
    });
    expect(info?.status).toBe(401);
    expect(info?.code).toBe('api_key_expired');
    expect(info?.type).toBe('provider.auth');
    expect(isAuthError(info)).toBe(true);
  });

  test('isAuthError is false for a generic error', () => {
    expect(isAuthError({ type: 'error', message: 'boom', status: null, code: null })).toBe(false);
  });

  test('classifyDriverError maps auth, timeout and generic errors', () => {
    expect(
      classifyDriverError(new Error('request failed {"status":401,"code":"api_key_expired"}'))
    ).toBeInstanceOf(DriverAuthError);
    expect(classifyDriverError(new Error('timed out after 100ms: wait'))).toBeInstanceOf(
      DriverTimeoutError
    );
    const generic = classifyDriverError(new Error('something else'));
    expect(generic).toBeInstanceOf(DriverError);
    expect(generic).not.toBeInstanceOf(DriverAuthError);
  });

  test('classifyDriverError passes typed errors through unchanged', () => {
    const original = new DriverAuthError('nope', {
      type: 'provider.auth',
      message: 'nope',
      status: 401,
      code: 'api_key_expired',
    });
    expect(classifyDriverError(original)).toBe(original);
  });
});

describe('createSdkDriver terminal-error promotion', () => {
  function instanceWith(messages: readonly unknown[]) {
    return {
      sessions: {
        async create() {
          return { id: 'ses_1' };
        },
        async prompt() {
          return {};
        },
        async wait() {
          return {};
        },
        async list() {
          return { data: [] };
        },
      },
      message: {
        async list() {
          return { data: messages };
        },
      },
    };
  }

  const authMessage = {
    type: 'assistant',
    content: [],
    model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'default' },
    cost: 0,
    finish: 'error',
    error: {
      type: 'provider.auth',
      message: 'This API key has expired.',
      status: 401,
      response: { body: '{"error":{"code":"api_key_expired"}}' },
    },
  };

  test('throws DriverAuthError when a turn finishes with a 401 transcript error', async () => {
    const driver = createSdkDriver({ createInstance: async () => instanceWith([authMessage]) });
    await expect(
      driver.runPrompt({ workspaceDir: '/tmp', prompt: 'x', limits: { steps: 1, timeoutMs: 500 } })
    ).rejects.toBeInstanceOf(DriverAuthError);
  });

  test('returns a normal result when the transcript has no error', async () => {
    const driver = createSdkDriver({
      createInstance: async () =>
        instanceWith([
          { type: 'assistant', content: [{ type: 'text', text: 'pong' }], finish: 'stop' },
        ]),
    });
    const result = await driver.runPrompt({
      workspaceDir: '/tmp',
      prompt: 'x',
      limits: { steps: 1, timeoutMs: 500 },
    });
    expect(result.finalText).toBe('pong');
  });
});
