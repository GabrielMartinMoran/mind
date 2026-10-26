import { describe, expect, test } from 'bun:test';

import {
  EmptySearchQueryError,
  EMPTY_SEARCH_QUERY_MESSAGE,
} from '../../../src/store/shared/search-query-error';
import { mapBridgeError, resolveBenchmarkRagMode } from '../bridge';

describe('OmniMemEval bridge error mapping', () => {
  test('maps the typed empty-search validation error to a client 400', () => {
    const mapped = mapBridgeError(new EmptySearchQueryError());

    expect(mapped.status).toBe(400);
    expect(mapped.body).toEqual({ error: EMPTY_SEARCH_QUERY_MESSAGE });
  });

  test('leaves unrelated errors as a generic 500 instead of masking them', () => {
    const mapped = mapBridgeError(new Error('unexpected search failure'));

    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: 'Error: unexpected search failure' });
  });
});

describe('OmniMemEval RAG mode', () => {
  test('keeps the baseline off unless RAG was explicitly requested', () => {
    expect(resolveBenchmarkRagMode(undefined)).toBe(false);
    expect(resolveBenchmarkRagMode('false')).toBe(false);
  });

  test('enables semantic search only when requested', () => {
    expect(resolveBenchmarkRagMode('true')).toBe(true);
  });

  test('rejects ambiguous RAG settings instead of silently falling back', () => {
    expect(() => resolveBenchmarkRagMode('on')).toThrow('MIND_RAG must be true or false');
  });
});
