import { describe, expect, test } from 'bun:test';

import { parseJsonContent, prettyPrintJson, tokenizeJson } from '../src/domain/json-viewer.js';

/** Concatenate token text, which must reproduce the source exactly. */
function joined(tokens: Array<{ text: string }>): string {
  return tokens.map(token => token.text).join('');
}

/** Token types paired with their text, ignoring whitespace. */
function significant(tokens: Array<{ type: string; text: string }>): Array<[string, string]> {
  return tokens.filter(token => token.type !== 'space').map(token => [token.type, token.text]);
}

describe('parseJsonContent', () => {
  test('parses valid JSON objects and arrays', () => {
    expect(parseJsonContent('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContent('  [1, 2, 3]  ')).toEqual([1, 2, 3]);
  });

  test('rejects non-JSON, primitives, and malformed documents', () => {
    expect(parseJsonContent('# Title\n\nBody')).toBeNull();
    expect(parseJsonContent('42')).toBeNull();
    expect(parseJsonContent('"text"')).toBeNull();
    expect(parseJsonContent('{"a": }')).toBeNull();
    expect(parseJsonContent('{invalid')).toBeNull();
    expect(parseJsonContent('')).toBeNull();
  });
});

describe('prettyPrintJson', () => {
  test('uses two-space indentation and keeps nested structure', () => {
    const source = '{"a":{"b":[1,true,null]},"c":"x"}';
    const pretty = prettyPrintJson(JSON.parse(source));

    expect(pretty).toBe(
      [
        '{',
        '  "a": {',
        '    "b": [',
        '      1,',
        '      true,',
        '      null',
        '    ]',
        '  },',
        '  "c": "x"',
        '}',
      ].join('\n')
    );
  });
});

describe('tokenizeJson', () => {
  test('round-trips the pretty JSON text exactly', () => {
    const pretty = prettyPrintJson({ a: [1, 'two', false, null], nested: { ok: true } });
    expect(joined(tokenizeJson(pretty))).toBe(pretty);
  });

  test('distinguishes keys from string values, numbers, booleans, null, and punctuation', () => {
    const pretty = prettyPrintJson({ name: 'value', count: -12.5e2, ok: false, empty: null });
    const tokens = significant(tokenizeJson(pretty));

    expect(tokens).toContainEqual(['key', '"name"']);
    expect(tokens).toContainEqual(['string', '"value"']);
    expect(tokens).toContainEqual(['key', '"count"']);
    expect(tokens).toContainEqual(['number', '-1250']);
    expect(tokens).toContainEqual(['boolean', 'false']);
    expect(tokens).toContainEqual(['null', 'null']);
    expect(tokens).toContainEqual(['punct', ':']);
    expect(tokens).toContainEqual(['punct', ',']);
    expect(tokens).toContainEqual(['punct', '{']);
    expect(tokens).toContainEqual(['punct', '}']);
  });

  test('keeps escaped quotes and backslashes inside string tokens', () => {
    const value = 'quote " and slash \\ and newline \n';
    const tokens = significant(tokenizeJson(prettyPrintJson(value)));
    const stringToken = tokens.find(([type]) => type === 'string');

    expect(stringToken?.[1]).toBe(JSON.stringify(value));
    // The closing quote of the value must not be mistaken for a new token.
    expect(tokens.filter(([type]) => type === 'string')).toHaveLength(1);
  });

  test('treats HTML-like content as inert string text', () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const tokens = tokenizeJson(prettyPrintJson({ payload }));
    const stringToken = tokens.find(token => token.type === 'string');

    expect(stringToken?.text).toBe(JSON.stringify(payload));
    // The highlighter is a text tokenizer: it never interprets the string as markup.
    expect(joined(tokens)).toContain(payload);
  });
});
