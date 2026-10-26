// ── Query parser + matching tokenizer (D2, D11) ──

import { describe, expect, test } from 'bun:test';

import { normalizeToken, tokenize } from '../src/store/shared/matching-tokenizer';
import {
  buildAnyMatch,
  buildPhraseMatch,
  buildPrimaryMatch,
  buildRungs,
  isEmptyQuery,
  parseQuery,
} from '../src/store/shared/query-parser';

describe('matching tokenizer (D11)', () => {
  test('folds case, accents and identifier separators', () => {
    expect(tokenize('Configuración-tempHP_2026')).toEqual(['configuracion', 'temp', 'hp', '2026']);
  });

  test('splits acronym boundaries', () => {
    expect(tokenize('HTTPServerError')).toEqual(['http', 'server', 'error']);
  });

  test('normalizeToken folds without splitting', () => {
    expect(normalizeToken('Acción')).toBe('accion');
    expect(normalizeToken('tokenBorderColor')).toBe('tokenbordercolor');
  });
});

describe('query parser — Query parsing rule', () => {
  test('quoted phrases are matched as phrases', () => {
    const ast = parseQuery('"exact phrase"');
    expect(ast.degraded).toBe(false);
    expect(ast.groups).toEqual([{ nodes: [{ type: 'phrase', text: 'exact phrase' }] }]);
    // Phrase text keeps its semantics (not tokenized/folded).
    expect(buildPrimaryMatch(ast)).toBe('"exact phrase"');
  });

  test('OR separates alternatives into a union', () => {
    const ast = parseQuery('alpha OR beta');
    expect(ast.groups).toEqual([
      { nodes: [{ type: 'term', token: 'alpha', prefix: false }] },
      { nodes: [{ type: 'term', token: 'beta', prefix: false }] },
    ]);
    expect(buildPrimaryMatch(ast)).toBe('("alpha" OR "beta")');
  });

  test('explicit AND behaves like implicit AND', () => {
    expect(parseQuery('auth AND jwt').groups).toEqual(parseQuery('auth jwt').groups);
    expect(buildPrimaryMatch(parseQuery('auth AND jwt'))).toBe(
      buildPrimaryMatch(parseQuery('auth jwt'))
    );
  });

  test('only uppercase AND, OR and NOT are operators', () => {
    const lowerAnd = parseQuery('auth and token');
    expect(lowerAnd.degraded).toBe(false);
    expect(lowerAnd.explicitAnd).toBe(false);
    expect(lowerAnd.groups).toEqual([
      {
        nodes: [
          { type: 'term', token: 'auth', prefix: false },
          { type: 'term', token: 'and', prefix: false },
          { type: 'term', token: 'token', prefix: false },
        ],
      },
    ]);

    const lowerOr = parseQuery('alpha or beta');
    expect(lowerOr.degraded).toBe(false);
    expect(lowerOr.groups).toEqual([
      {
        nodes: [
          { type: 'term', token: 'alpha', prefix: false },
          { type: 'term', token: 'or', prefix: false },
          { type: 'term', token: 'beta', prefix: false },
        ],
      },
    ]);

    const lowerNot = parseQuery('auth not jwt');
    expect(lowerNot.degraded).toBe(false);
    expect(lowerNot.exclude).toEqual([]);
    expect(lowerNot.groups).toEqual([
      {
        nodes: [
          { type: 'term', token: 'auth', prefix: false },
          { type: 'term', token: 'not', prefix: false },
          { type: 'term', token: 'jwt', prefix: false },
        ],
      },
    ]);
  });

  test('records explicit uppercase AND provenance', () => {
    expect(parseQuery('auth AND jwt').explicitAnd).toBe(true);
    expect(parseQuery('auth jwt').explicitAnd).toBe(false);
    expect(parseQuery('auth and jwt').explicitAnd).toBe(false);
    expect(parseQuery('auth OR jwt').explicitAnd).toBe(false);
    expect(parseQuery('auth NOT jwt').explicitAnd).toBe(false);
    // Degraded input treats operator words literally, so provenance stays false.
    expect(parseQuery('OR OR auth NOT').explicitAnd).toBe(false);
  });

  test('NOT excludes the following term', () => {
    const ast = parseQuery('auth NOT jwt');
    expect(ast.groups).toEqual([{ nodes: [{ type: 'term', token: 'auth', prefix: false }] }]);
    expect(ast.exclude).toEqual([{ type: 'term', token: 'jwt', prefix: false }]);
    expect(buildPrimaryMatch(ast)).toBe('("auth") NOT ("jwt")');
  });

  test('a trailing prefix wildcard expands a term', () => {
    const ast = parseQuery('type*');
    expect(ast.groups).toEqual([{ nodes: [{ type: 'term', token: 'type', prefix: true }] }]);
    expect(buildPrimaryMatch(ast)).toBe('"type"*');
  });

  test('malformed operator usage degrades to literal AND', () => {
    const ast = parseQuery('OR OR auth NOT');
    expect(ast.degraded).toBe(true);
    expect(ast.groups).toHaveLength(1);
    expect(ast.exclude).toHaveLength(0);
    // Terms are treated literally (operators included), never raw FTS passthrough.
    const tokens = ast.groups[0]!.nodes.map(node =>
      node.type === 'term' ? node.token : node.text
    );
    expect(tokens).toEqual(['or', 'or', 'auth', 'not']);
    expect(() => parseQuery('OR OR auth NOT')).not.toThrow();
  });

  test('unclosed quote degrades without throwing', () => {
    const ast = parseQuery('auth "unclosed');
    expect(ast.degraded).toBe(true);
    expect(() => buildPrimaryMatch(ast)).not.toThrow();
  });

  test('mixed quotes and OR', () => {
    const ast = parseQuery('alpha OR "beta gamma"');
    expect(ast.groups).toEqual([
      { nodes: [{ type: 'term', token: 'alpha', prefix: false }] },
      { nodes: [{ type: 'phrase', text: 'beta gamma' }] },
    ]);
  });

  test('empty query is empty', () => {
    const ast = parseQuery('   ');
    expect(isEmptyQuery(ast)).toBe(true);
    expect(buildPrimaryMatch(ast)).toBe('');
  });
});

describe('query parser — MATCH builders and rungs', () => {
  test('single-term parity with legacy sanitizer', () => {
    expect(buildPrimaryMatch(parseQuery('auth'))).toBe('"auth"');
    expect(buildPrimaryMatch(parseQuery('auth token'))).toBe('"auth" "token"');
    expect(buildPrimaryMatch(parseQuery('auth*'))).toBe('"auth"*');
  });

  test('single-term query produces one rung (no redundant work)', () => {
    expect(buildRungs(parseQuery('auth'))).toEqual([{ method: 'all', match: '"auth"' }]);
  });

  test('multi-term query produces phrase > all > any rungs', () => {
    const rungs = buildRungs(parseQuery('token color'));
    expect(rungs.map(r => r.method)).toEqual(['phrase', 'all', 'any']);
    expect(rungs[0]!.match).toBe('"token color"');
    expect(rungs[1]!.match).toBe('"token" "color"');
    expect(rungs[2]!.match).toBe('("token" OR "color")');
  });

  test('OR query has no phrase rung', () => {
    const rungs = buildRungs(parseQuery('alpha OR beta'));
    expect(rungs.some(r => r.method === 'phrase')).toBe(false);
  });

  test('excludes are threaded through every rung', () => {
    expect(buildPrimaryMatch(parseQuery('auth NOT jwt'))).toContain('NOT');
    expect(buildAnyMatch(parseQuery('auth NOT jwt'))).toContain('NOT');
    expect(buildPhraseMatch(parseQuery('auth jwt NOT exp'))).toContain('NOT');
  });

  test('phrase rung is null for a single term', () => {
    expect(buildPhraseMatch(parseQuery('auth'))).toBeNull();
    expect(buildAnyMatch(parseQuery('auth'))).toBe('"auth"');
  });
});
