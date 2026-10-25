import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildInformativeAnyMatch,
  informativeSearchTokens,
  isNaturalLanguageRecall,
} from '../src/store/shared/natural-search';
import { parseQuery } from '../src/store/shared/query-parser';

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
  test('compiles sanitized informative terms into a disjunction', () => {
    expect(buildInformativeAnyMatch(['cloudflare', '2026'])).toBe('"cloudflare" OR "2026"');
    expect(buildInformativeAnyMatch([])).toBe('');
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
