// QA-T5 regression: a failed session must keep the transcript it produced.

import { describe, expect, test } from 'bun:test';

import {
  buildErrorOutcome,
  captureChildren,
  extractSearchProvenance,
  redactTranscript,
} from '../src/benchmarkB/worker';
import {
  DriverAuthError,
  buildDriverEvidence,
  type DriverErrorInfo,
  type DriverErrorWithPartial,
  type DriverRunResult,
} from '../src/opencode/driver';

const AUTH_INFO: DriverErrorInfo = {
  type: 'provider.auth',
  message: 'api_key_expired',
  status: 401,
  code: 'api_key_expired',
};

function partialResult(sessionId: string): DriverRunResult {
  return {
    sessionId,
    finalText: 'half an answer',
    assistantTexts: ['half an answer'],
    toolCalls: [],
    memoryCalls: 0,
    model: null,
    costUsd: 0,
    tokens: null,
    steps: 1,
    latencyMs: 5,
    finish: 'error',
    error: AUTH_INFO,
  };
}

describe('buildErrorOutcome (QA-T5)', () => {
  test('keeps the raw transcript for a partial failure instead of an empty stub', async () => {
    const error = new DriverAuthError('expired', AUTH_INFO) as DriverErrorWithPartial;
    error.partial = partialResult('ses_partial');
    const transcript = { data: [{ type: 'assistant', content: [] }] };

    const outcome = await buildErrorOutcome(error, {
      rawMessages: async sessionId => {
        expect(sessionId).toBe('ses_partial');
        return transcript;
      },
    });

    expect(outcome.status).toBe('auth');
    expect(outcome.sessionId).toBe('ses_partial');
    expect(outcome.rawMessages).toEqual(transcript);
  });

  test('falls back to an empty transcript when the raw read fails', async () => {
    const error = new DriverAuthError('expired', AUTH_INFO) as DriverErrorWithPartial;
    error.partial = partialResult('ses_x');
    const outcome = await buildErrorOutcome(error, {
      rawMessages: async () => {
        throw new Error('gone');
      },
    });
    expect(outcome.status).toBe('auth');
    expect(outcome.rawMessages).toEqual({ data: [] });
    const evidence = (
      outcome as typeof outcome & { evidence?: { status: string; reason: string | null } }
    ).evidence;
    expect(evidence?.status).toBe('unavailable');
    expect(evidence?.reason).toContain('gone');
  });

  test('returns an empty outcome when there is no partial transcript', async () => {
    const outcome = await buildErrorOutcome(new Error('boom'), {
      rawMessages: async () => ({ data: ['never'] }),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.sessionId).toBe('');
    expect(outcome.rawMessages).toEqual({ data: [] });
    const evidence = (outcome as typeof outcome & { evidence?: { status: string } }).evidence;
    expect(evidence?.status).toBe('unavailable');
  });
});

describe('redacted transcript persistence', () => {
  function transcript(): unknown {
    return {
      data: [
        { type: 'user', content: [{ type: 'text', text: 'secret prompt text' }] },
        {
          type: 'assistant',
          content: [
            {
              type: 'tool',
              name: 'skill',
              state: {
                input: { id: 'mind-management' },
                content: [{ type: 'text', text: 'secret skill body' }],
              },
            },
            {
              type: 'tool',
              name: 'execute',
              state: {
                input: { code: "tools.mind.memory_query({ search: 'secret' })" },
                content: [{ type: 'text', text: 'secret memory content' }],
              },
            },
          ],
        },
        { type: 'skill', skill: 'mind-management', name: 'mind-management' },
      ],
    };
  }

  test('keeps ordered tool names and skill ids while dropping content', () => {
    const redacted = JSON.stringify(redactTranscript(transcript()));
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('mind-management');
    expect(redacted).toContain('tools.mind.memory_query');
    expect(redacted).not.toContain('secret memory content');
  });

  test('retains a skill id but drops a non-skill tool argument named name', () => {
    const raw = {
      data: [
        {
          type: 'assistant',
          content: [
            {
              type: 'tool',
              name: 'mind_memory_query',
              state: {
                input: { name: 'secret-target-name' },
                content: [{ type: 'text', text: 'secret result' }],
              },
            },
            {
              type: 'tool',
              name: 'skill',
              state: { input: { id: 'mind-management', name: 'mind-management' } },
            },
            {
              type: 'tool',
              name: 'execute',
              state: {
                input: { code: 'tools.mind.memory_query({})' },
                metadata: {
                  toolCalls: [
                    { tool: 'mind.memory_query', args: { name: 'secret-nested-name' } },
                    { tool: 'skill', args: { id: 'mind-management' } },
                  ],
                },
              },
            },
          ],
        },
      ],
    };

    const redacted = redactTranscript(raw) as {
      data: {
        content: {
          name: string;
          state: {
            input: Record<string, unknown>;
            metadata?: { toolCalls?: { tool: string; args: Record<string, unknown> }[] };
          };
        }[];
      }[];
    };

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('secret-target-name');
    expect(serialized).not.toContain('secret-nested-name');

    const parts = redacted.data[0]!.content;
    expect(parts[0]!.state.input).toEqual({});
    expect(parts[1]!.state.input).toEqual({ id: 'mind-management', name: 'mind-management' });
    expect(parts[2]!.state.metadata?.toolCalls).toEqual([
      { tool: 'mind.memory_query', args: {} },
      { tool: 'skill', args: { id: 'mind-management' } },
    ]);
  });

  test('preserves the tool order the B11 assertion reads', () => {
    const redacted = redactTranscript(transcript()) as {
      data: { type: string; content?: { name?: string }[] }[];
    };
    expect(redacted.data.map(message => message.type)).toEqual(['assistant', 'skill']);
    expect(redacted.data[0]?.content?.map(part => part.name)).toEqual(['skill', 'execute']);
  });
});

describe('memory_query provenance extraction (B10)', () => {
  const YAML_RESULT = [
    'memories:',
    '  - name: release-key-rotation',
    '    content: secret target content',
    '    methods:',
    '      - all',
    '      - semantic',
    'total: 1',
    'limit: 25',
    'offset: 0',
    'search_method: mixed',
  ].join('\n');

  function toolPart(name: string, state: Record<string, unknown>): unknown {
    return { type: 'tool', name, state };
  }

  test('reads the target name and methods without retaining content', () => {
    const raw = {
      data: [
        {
          type: 'assistant',
          content: [
            toolPart('mind_memory_query', { content: [{ type: 'text', text: YAML_RESULT }] }),
          ],
        },
      ],
    };
    const provenance = extractSearchProvenance(raw);
    expect(provenance).toEqual([{ name: 'release-key-rotation', methods: ['all', 'semantic'] }]);
    expect(JSON.stringify(provenance)).not.toContain('secret');
  });

  test('reads provenance from a code-mode execute result for a nested memory_query', () => {
    const raw = {
      data: [
        {
          type: 'assistant',
          content: [
            toolPart('execute', {
              metadata: { toolCalls: [{ tool: 'mind.memory_query' }] },
              content: [{ type: 'text', text: YAML_RESULT }],
            }),
          ],
        },
      ],
    };
    expect(extractSearchProvenance(raw)).toEqual([
      { name: 'release-key-rotation', methods: ['all', 'semantic'] },
    ]);
  });

  test('ignores tool results that are not memory_query calls', () => {
    const raw = {
      data: [
        {
          type: 'assistant',
          content: [toolPart('read', { content: [{ type: 'text', text: YAML_RESULT }] })],
        },
      ],
    };
    expect(extractSearchProvenance(raw)).toEqual([]);
  });
});

describe('child evidence capture (B4)', () => {
  test('a failed child-list capture stays unavailable and never looks like no children', async () => {
    const base = buildDriverEvidence({
      sessionId: 'ses_parent',
      messages: [],
      childSessionIds: null,
      idleOutcome: 'succeeded',
      reason: 'child list failed',
    });

    const captured = await captureChildren({ rawMessages: async () => ({ data: [] }) }, base);

    expect(captured.children).toEqual([]);
    expect(captured.evidence.status).toBe('unavailable');
    expect(captured.evidence.children).toBe('unavailable');
    expect(captured.evidence.reason).toContain('child list failed');
  });

  test('a failed child transcript marks the evidence unavailable', async () => {
    const base = buildDriverEvidence({
      sessionId: 'ses_parent',
      messages: [],
      childSessionIds: ['ses_child'],
      idleOutcome: 'succeeded',
    });

    const captured = await captureChildren(
      {
        rawMessages: async () => {
          throw new Error('child transcript gone');
        },
      },
      base
    );

    expect(captured.children).toHaveLength(1);
    expect(captured.children[0]?.error).toBe('child transcript unavailable');
    expect(captured.evidence.status).toBe('unavailable');
    expect(captured.evidence.reason).toContain('child transcript');
    expect(captured.evidence.childSessionIds).toEqual(['ses_child']);
  });
});
