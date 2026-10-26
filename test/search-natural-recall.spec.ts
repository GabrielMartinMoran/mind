import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildInformativeAnyMatch,
  hasInformativeQueryTerms,
  informativeSearchTokens,
  isInformativeQueryTerm,
  isNaturalLanguageRecall,
} from '../src/store/shared/natural-search';
import { parseQuery } from '../src/store/shared/query-parser';
import {
  EmptySearchQueryError,
  EMPTY_SEARCH_QUERY_MESSAGE,
} from '../src/store/shared/search-query-error';

import { createTestStore } from './mocks/test-store';

describe('natural search terms', () => {
  test('ignores function words without losing domain words or identifiers', () => {
    expect(informativeSearchTokens(['de', 'el', 'para', 'la', 'cloudflare', 'ip', '2026'])).toEqual(
      ['cloudflare', 'ip', '2026']
    );
    expect(informativeSearchTokens(['what', 'is', 'the', 'issue', 'with', 'jwt'])).toEqual([
      'issue',
      'jwt',
    ]);
  });
  test('does not broaden explicit syntax or short keyword queries', () => {
    expect(isNaturalLanguageRecall(parseQuery('what changed about cloudflare?'))).toBe(true);
    expect(isNaturalLanguageRecall(parseQuery('how did cloudflare change'))).toBe(false);
    expect(isNaturalLanguageRecall(parseQuery('cómo migran las aves entre continentes'))).toBe(
      false
    );
    expect(isNaturalLanguageRecall(parseQuery('glossary glosario bilingue'))).toBe(false);
    for (const query of [
      'auth token',
      'auth AND token details',
      'auth OR token details',
      'auth NOT token details',
      '"the project" last week',
      'auth* token details',
      'OR OR auth NOT',
    ]) {
      expect(isNaturalLanguageRecall(parseQuery(query))).toBe(false);
    }
  });
  test('treats lowercase and/or in a punctuated question as ordinary terms', () => {
    expect(isNaturalLanguageRecall(parseQuery('what is the issue with auth and tokens?'))).toBe(
      true
    );
    expect(isNaturalLanguageRecall(parseQuery('should we use rag or openrouter?'))).toBe(true);
  });
  test('uppercase AND disqualifies broad question recall', () => {
    expect(isNaturalLanguageRecall(parseQuery('what changed about cloudflare AND tunnel?'))).toBe(
      false
    );
  });
  test('compiles sanitized informative terms into a disjunction', () => {
    expect(buildInformativeAnyMatch(['cloudflare', '2026'])).toBe('"cloudflare" OR "2026"');
    expect(buildInformativeAnyMatch([])).toBe('');
  });
});

describe('informative query validation (unit)', () => {
  test('finds no informative terms in empty, whitespace, stopword-only or quoted-stopword-only text', () => {
    for (const query of ['', '   ', 'the and for', 'de la para', '"the and for"', '???']) {
      expect(hasInformativeQueryTerms(parseQuery(query))).toBe(false);
    }
  });

  test('recognises non-Latin words so supported scripts are never treated as empty', () => {
    for (const query of ['привет', 'γειά', '天気', '"привет мир"', 'こんにちは']) {
      expect(hasInformativeQueryTerms(parseQuery(query))).toBe(true);
    }
  });

  test('keeps mixed queries that retain at least one informative term', () => {
    for (const query of ['the auth', 'de la nube', '¿qué pasó con cloudflare?', 'auth AND the']) {
      expect(hasInformativeQueryTerms(parseQuery(query))).toBe(true);
    }
  });

  test('exposes one shared stopword predicate', () => {
    expect(isInformativeQueryTerm('the')).toBe(false);
    expect(isInformativeQueryTerm('para')).toBe(false);
    expect(isInformativeQueryTerm('auth')).toBe(true);
    expect(informativeSearchTokens(['the', 'auth'])).toEqual(['auth']);
  });
});

describe('natural recall admission (store integration)', () => {
  let store: ReturnType<typeof createTestStore> | null = null;
  afterEach(() => {
    store?.cleanup();
    store = null;
  });

  test('retains partial evidence even alongside a perfect match', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'complete', 'cloudflare tunnel latency investigation', {
      tags: ['test'],
    });
    await store.addMemory('example', 'partial', 'cloudflare routing', { tags: ['test'] });
    await store.addMemory('example', 'other', 'latency over the office network', {
      tags: ['test'],
    });
    await store.addMemory('example', 'noise', 'the and for de la para', { tags: ['test'] });
    const results = await store.search('What cloudflare tunnel latency investigation?', {
      space: 'example',
      semantic: false,
      limit: 20,
    });
    const names = results.map(result => result.name);
    expect(names).toContain('complete');
    expect(names).toContain('partial');
    expect(names).toContain('other');
    expect(names).not.toContain('noise');
  });

  test('retains boolean AND, NOT and quoted phrase semantics', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'full', 'cloudflare tunnel latency', { tags: ['test'] });
    await store.addMemory('example', 'partial', 'cloudflare incident', { tags: ['test'] });
    const search = (query: string) => store!.search(query, { space: 'example', semantic: false });
    expect((await search('cloudflare AND tunnel latency')).map(row => row.name)).toEqual(['full']);
    expect((await search('cloudflare NOT incident')).map(row => row.name)).not.toContain('partial');
    expect((await search('"cloudflare tunnel"')).map(row => row.name)).toEqual(['full']);
  });

  test('filters lowercase and from a punctuated question and ranks stronger evidence first', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'strong', 'cloudflare tunnel latency', { tags: ['test'] });
    await store.addMemory('example', 'partial', 'cloudflare routing', { tags: ['test'] });
    await store.addMemory('example', 'noise', 'the and for de la para', { tags: ['test'] });
    const results = await store.search('What is the issue with cloudflare and latency?', {
      space: 'example',
      semantic: false,
      limit: 20,
    });
    const names = results.map(result => result.name);
    expect(names).toContain('strong');
    expect(names).toContain('partial');
    expect(names).not.toContain('noise');
    expect(names.indexOf('strong')).toBeLessThan(names.indexOf('partial'));
  });

  test('never admits a document matched only by Spanish or English stopwords', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'noise', 'de el para la the for and', { tags: ['test'] });
    await store.addMemory('example', 'signal', 'cloudflare router', { tags: ['test'] });
    const results = await store.search('Cuál es el router de cloudflare?', {
      space: 'example',
      semantic: false,
    });
    expect(results.map(row => row.name)).toEqual(['signal']);
  });
});

describe('supplied search validation (store integration)', () => {
  let store: ReturnType<typeof createTestStore> | null = null;
  afterEach(() => {
    store?.cleanup();
    store = null;
  });

  test('rejects empty, whitespace, stopword-only and quoted-stopword-only searches', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);

    for (const query of ['', '   ', 'the and for de la', '"the and for"']) {
      await expect(
        store.search(query, { space: 'example', semantic: false })
      ).rejects.toBeInstanceOf(EmptySearchQueryError);
    }
  });

  test('validates before retrieving candidates that the stopword query would otherwise match', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'stopword-doc', 'the and for de la para', { tags: ['test'] });

    // If any lexical rung ran first this document would be returned; the typed
    // validation error proves the choke point runs before candidate channels.
    await expect(
      store.search('the and for de la para', { space: 'example', semantic: false })
    ).rejects.toThrow(EMPTY_SEARCH_QUERY_MESSAGE);
  });

  test('does not reject a non-Latin query as empty', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'russian', 'привет мир', { tags: ['test'] });

    const results = await store.search('привет', { space: 'example', semantic: false });
    expect(Array.isArray(results)).toBe(true);
  });

  test('still searches mixed queries that retain an informative term', async () => {
    store = createTestStore();
    store.createSpace('example', 'Example', ['test']);
    await store.addMemory('example', 'signal', 'the cloudflare routing', { tags: ['test'] });

    const results = await store.search('the cloudflare', { space: 'example', semantic: false });
    expect(results.map(row => row.name)).toContain('signal');
  });
});
