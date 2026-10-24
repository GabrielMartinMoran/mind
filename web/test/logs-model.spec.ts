import { describe, expect, test } from 'bun:test';

import {
  MAX_ROWS,
  capLogRows,
  describeLogAgent,
  filterParams,
  formatDuration,
  formatLogTime,
  normalizeLogs,
  paginationRange,
  parseCallerInfo,
  shouldPoll,
  toIsoDateTime,
} from '../src/domain/logs-model.js';

describe('parseCallerInfo', () => {
  test('parses a caller_info object', () => {
    expect(parseCallerInfo({ agent: 'opencode', transport: 'stdio' })).toEqual({
      agent: 'opencode',
      transport: 'stdio',
    });
  });

  test('parses a JSON string', () => {
    expect(parseCallerInfo('{"agent":"claude-code","agentSource":"env"}')).toEqual({
      agent: 'claude-code',
      agentSource: 'env',
    });
  });

  test('returns null for malformed JSON instead of throwing', () => {
    expect(parseCallerInfo('{not json')).toBeNull();
    expect(parseCallerInfo('[1,2]')).toBeNull();
    expect(parseCallerInfo('"agent"')).toBeNull();
    expect(parseCallerInfo(42)).toBeNull();
  });

  test('returns null when caller_info is missing or empty', () => {
    expect(parseCallerInfo(null)).toBeNull();
    expect(parseCallerInfo(undefined)).toBeNull();
    expect(parseCallerInfo('')).toBeNull();
  });
});

describe('describeLogAgent', () => {
  test('maps known canonical agents to compact labels and keeps the raw value', () => {
    const cases = [
      ['opencode', 'OpenCode'],
      ['claude-code', 'Claude Code'],
      ['codex', 'Codex'],
      ['cursor', 'Cursor'],
      ['windsurf', 'Windsurf'],
      ['gemini-cli', 'Gemini CLI'],
      ['vscode', 'VS Code'],
      ['antigravity', 'Antigravity'],
      ['pi', 'Pi'],
    ] as const;

    for (const [agent, label] of cases) {
      expect(describeLogAgent({ agent })).toEqual({ agent, label, raw: agent });
    }
  });

  test('accepts caller_info as a JSON string', () => {
    expect(describeLogAgent('{"agent":"codex"}')).toEqual({
      agent: 'codex',
      label: 'Codex',
      raw: 'codex',
    });
  });

  test('shows an unknown canonical value as its raw name', () => {
    expect(describeLogAgent({ agent: 'future-client' })).toEqual({
      agent: 'future-client',
      label: 'future-client',
      raw: 'future-client',
    });
  });

  test('treats a missing, unknown or malformed agent as absent', () => {
    for (const callerInfo of [
      null,
      undefined,
      {},
      { agent: '' },
      { agent: 'unknown' },
      { agent: 42 },
      'not-json',
    ]) {
      expect(describeLogAgent(callerInfo as never)).toEqual({ agent: null, label: '', raw: '' });
    }
  });
});

describe('normalizeLogs', () => {
  test('returns safe defaults for a missing response', () => {
    expect(normalizeLogs()).toEqual({ logs: [], total: 0, limit: 25, offset: 0 });
    expect(normalizeLogs(null)).toEqual({ logs: [], total: 0, limit: 25, offset: 0 });
  });

  test('passes valid fields through unchanged', () => {
    const logs = [{ id: 1, operation: 'add_memory' }];
    expect(normalizeLogs({ logs, total: 3, limit: 10, offset: 20 })).toEqual({
      logs,
      total: 3,
      limit: 10,
      offset: 20,
    });
  });

  test('rejects an invalid logs payload and clamps bad numbers', () => {
    expect(normalizeLogs({ logs: 'nope', total: -5, limit: 0, offset: -2 } as never)).toEqual({
      logs: [],
      total: 0,
      limit: 25,
      offset: 0,
    });
  });

  test('falls back to the log count when total is missing', () => {
    expect(normalizeLogs({ logs: [{ id: 1 }, { id: 2 }] }).total).toBe(2);
  });

  test('clamps a limit above MAX_ROWS', () => {
    expect(normalizeLogs({ limit: 1000 }).limit).toBe(MAX_ROWS);
  });
});

describe('filterParams', () => {
  test('always carries limit and offset with defaults', () => {
    expect(filterParams({})).toEqual({ limit: 25, offset: 0 });
  });

  test('trims strings, drops empty and unknown values, and clamps the limit', () => {
    expect(
      filterParams({
        source: 'cli',
        operation: ' add_memory ',
        level: 'error',
        search: ' foo ',
        from: '2026-01-01',
        to: '2026-01-31',
        limit: 1000,
        offset: 50,
      })
    ).toEqual({
      source: 'cli',
      operation: 'add_memory',
      level: 'error',
      search: 'foo',
      from: '2026-01-01',
      to: '2026-01-31',
      limit: MAX_ROWS,
      offset: 50,
    });
  });

  test('omits the "all" source and an invalid level', () => {
    expect(filterParams({ source: 'all', level: 'debug' })).toEqual({ limit: 25, offset: 0 });
  });

  test('validates the source against the allowed values and normalizes case', () => {
    expect(filterParams({ source: 'bogus' })).toEqual({ limit: 25, offset: 0 });
    expect(filterParams({ source: ' CLI ' })).toEqual({ source: 'cli', limit: 25, offset: 0 });
  });
});

describe('paginationRange', () => {
  test('computes the first page', () => {
    expect(paginationRange({ total: 120, limit: 25, offset: 0 })).toEqual({
      from: 1,
      to: 25,
      page: 1,
      pages: 5,
      hasPrev: false,
      hasNext: true,
    });
  });

  test('computes the last page', () => {
    expect(paginationRange({ total: 120, limit: 25, offset: 100 })).toEqual({
      from: 101,
      to: 120,
      page: 5,
      pages: 5,
      hasPrev: true,
      hasNext: false,
    });
  });

  test('handles an empty collection', () => {
    expect(paginationRange({ total: 0, limit: 25, offset: 0 })).toEqual({
      from: 0,
      to: 0,
      page: 1,
      pages: 0,
      hasPrev: false,
      hasNext: false,
    });
  });

  test('clamps an offset past the end', () => {
    expect(paginationRange({ total: 20, limit: 10, offset: 100 })).toEqual({
      from: 20,
      to: 20,
      page: 2,
      pages: 2,
      hasPrev: true,
      hasNext: false,
    });
  });
});

describe('capLogRows', () => {
  test('keeps the newest rows and reports how many were dropped', () => {
    const logs = Array.from({ length: 600 }, (_, index) => ({ id: 600 - index }));
    const result = capLogRows(logs);

    expect(result.logs).toHaveLength(MAX_ROWS);
    expect(result.logs[0].id).toBe(600);
    expect(result.logs[result.logs.length - 1].id).toBe(101);
    expect(result.dropped).toBe(100);
  });

  test('supports a custom cap', () => {
    expect(capLogRows([{ id: 1 }, { id: 2 }, { id: 3 }], 2)).toEqual({
      logs: [{ id: 1 }, { id: 2 }],
      dropped: 1,
    });
  });

  test('treats a non-array as empty', () => {
    expect(capLogRows(null as never)).toEqual({ logs: [], dropped: 0 });
  });
});

describe('formatLogTime', () => {
  test('formats the backend timestamp deterministically in UTC', () => {
    expect(formatLogTime('2026-10-20 10:00:00')).toBe('2026-10-20 10:00:00');
    expect(formatLogTime('2026-10-20T10:00:00Z')).toBe('2026-10-20 10:00:00');
    expect(formatLogTime('2026-01-02 03:04:05')).toBe('2026-01-02 03:04:05');
  });

  test('returns an empty string for missing or invalid values', () => {
    expect(formatLogTime('')).toBe('');
    expect(formatLogTime(undefined)).toBe('');
    expect(formatLogTime('not-a-date')).toBe('');
  });
});

describe('toIsoDateTime', () => {
  test('converts the backend timestamp to an ISO datetime with a T separator', () => {
    expect(toIsoDateTime('2026-10-20 10:00:00')).toBe('2026-10-20T10:00:00Z');
    expect(toIsoDateTime('2026-10-20T10:00:00Z')).toBe('2026-10-20T10:00:00Z');
    expect(toIsoDateTime('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05Z');
  });

  test('returns an empty string for missing or invalid values', () => {
    expect(toIsoDateTime('')).toBe('');
    expect(toIsoDateTime(null)).toBe('');
    expect(toIsoDateTime('not-a-date')).toBe('');
  });
});

describe('formatDuration', () => {
  test('formats finite milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(12.6)).toBe('13ms');
    expect(formatDuration(1500)).toBe('1500ms');
  });

  test('returns an em dash when there is no duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('shouldPoll', () => {
  test.each([
    [{ live: true, visible: true, status: 'success' }, true],
    [{ live: true, status: 'idle' }, true],
    [{ live: false, visible: true, status: 'success' }, false],
    [{ live: true, visible: false, status: 'success' }, false],
    [{ live: true, visible: true, status: 'loading' }, false],
    [{ live: true, visible: true, status: 'error' }, false],
  ] as const)('shouldPoll(%p) is %p', (input, expected) => {
    expect(shouldPoll(input)).toBe(expected);
  });
});
