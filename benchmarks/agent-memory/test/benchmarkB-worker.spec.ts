// QA-T5 regression: a failed session must keep the transcript it produced.

import { describe, expect, test } from 'bun:test';

import { buildErrorOutcome } from '../src/benchmarkB/worker';
import {
  DriverAuthError,
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
  });

  test('returns an empty outcome when there is no partial transcript', async () => {
    const outcome = await buildErrorOutcome(new Error('boom'), {
      rawMessages: async () => ({ data: ['never'] }),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.sessionId).toBe('');
    expect(outcome.rawMessages).toEqual({ data: [] });
  });
});
