// ── Fuzzy channel (P-A: global folded-vocabulary cache + banded OSA) ──
//
// The production fuzzy channel (the §8bis P-A fallback that replaced the
// retired v10 dictionary) generates candidates from the FULL folded document
// vocabulary of the store — folded once and cached in memory, keyed by the
// store write generation — scores them with a banded/early-exit OSA ≤2, and
// requires a shared ≥3-character prefix.
//
// These tests pin the behavior the optimization must preserve, plus the one
// documented P-A limitation: a typo in the first three characters of a word is
// NOT recoverable, because only vocabulary terms sharing a 3-character prefix
// with the query token are considered.

import { describe, expect, test } from 'bun:test';

import {
  bandedOsa,
  expandFuzzyTokens,
  foldedVocabulary,
  FUZZY_MAX_DISTANCE,
  FUZZY_MAX_EXPANSIONS,
  FUZZY_PREFIX_LENGTH,
  TRIGRAM_MIN_LENGTH,
  type ScoredSearchResult,
} from '../src/store/repositories/search-repository';
import { foldedWords } from '../src/store/shared';

import { createTestStore } from './mocks/test-store';
import { FIXTURE_CORPUS } from './search-eval/corpus';

function names(results: ScoredSearchResult[]): string[] {
  return results.map(result => result.name);
}

/** Length of the longest common leading substring of two strings. */
function sharedPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}

/**
 * Independent copy of the pre-change implementation (it normalized the
 * vocabulary internally with `[...new Set(vocabulary)].sort()`). Kept only as a
 * reference for the differential equivalence test; production no longer
 * copies/sorts the shared, already-normalized vocabulary.
 */
function legacyExpandFuzzyTokens(
  tokens: string[],
  vocabulary: Iterable<string>,
  maxExpansions: number = FUZZY_MAX_EXPANSIONS
): Map<string, string[]> {
  const vocab = [...new Set(vocabulary)].sort();
  const result = new Map<string, string[]>();
  let budget = maxExpansions;
  for (const token of [...new Set(tokens)].sort()) {
    const matches: string[] = [];
    if (token.length >= FUZZY_PREFIX_LENGTH) {
      for (const word of vocab) {
        if (budget <= 0) break;
        if (word === token) continue;
        if (sharedPrefix(word, token) < FUZZY_PREFIX_LENGTH) continue;
        if (Math.abs(word.length - token.length) > FUZZY_MAX_DISTANCE) continue;
        if (bandedOsa(word, token, FUZZY_MAX_DISTANCE) <= FUZZY_MAX_DISTANCE) {
          matches.push(word);
          budget -= 1;
        }
      }
    }
    result.set(token, matches);
  }
  return result;
}

/** Unique, sorted folded vocabulary of the committed fixture corpus. */
function fixtureVocabulary(): string[] {
  return [
    ...new Set(FIXTURE_CORPUS.flatMap(doc => [...foldedWords(`${doc.name} ${doc.content}`)])),
  ].sort();
}

/**
 * Deterministic broad token sample (exact hits, typos past the prefix-3 floor,
 * and guaranteed no-match tokens) drawn from the fixture vocabulary.
 */
function buildTokenSample(vocabulary: string[], count: number): string[] {
  const tokens: string[] = [];
  for (const word of vocabulary) {
    if (tokens.length >= count) break;
    if (word.length >= FUZZY_PREFIX_LENGTH) tokens.push(word);
  }
  for (const word of vocabulary) {
    if (tokens.length >= count) break;
    if (word.length > FUZZY_PREFIX_LENGTH) {
      tokens.push(word.slice(0, -1) + (word.endsWith('z') ? 'q' : 'z'));
    }
  }
  for (let i = 0; tokens.length < count; i += 1) tokens.push(`zzqx${i}`);
  return tokens;
}

describe('bandedOsa (early-exit optimal string alignment)', () => {
  test('matches the exact distance for close strings', () => {
    expect(bandedOsa('cache', 'cache', FUZZY_MAX_DISTANCE)).toBe(0);
    expect(bandedOsa('embeddings', 'embeddigs', FUZZY_MAX_DISTANCE)).toBe(1);
    expect(bandedOsa('cart', 'crat', FUZZY_MAX_DISTANCE)).toBe(1); // transposition
    expect(bandedOsa('puntaroca', 'puntroca', FUZZY_MAX_DISTANCE)).toBe(1);
  });

  test('returns a bound-exceeding sentinel without scanning dissimilar strings', () => {
    const result = bandedOsa('aaaa', 'bbbb', FUZZY_MAX_DISTANCE);
    expect(result).toBeGreaterThan(FUZZY_MAX_DISTANCE);
  });
});

describe('expandFuzzyTokens — global vocabulary scan with a ≥3 prefix floor', () => {
  test('the prefix floor equals the trigram minimum (documented P-A limitation)', () => {
    expect(FUZZY_PREFIX_LENGTH).toBe(TRIGRAM_MIN_LENGTH);
    expect(FUZZY_PREFIX_LENGTH).toBe(3);
  });

  test('recovers a typo when the candidate shares a ≥3 character prefix', () => {
    expect(expandFuzzyTokens(['cache'], ['ca', 'caché']).get('cache')).toEqual(['caché']);
  });

  test('does NOT recover a first-3-character typo (prefix floor)', () => {
    // "xmbeddings" vs "embeddings" share no leading character.
    expect(expandFuzzyTokens(['xmbeddings'], ['embeddings']).get('xmbeddings')).toEqual([]);
    // "cach"/"cash" share only "ca" (2 < 3).
    expect(expandFuzzyTokens(['cach'], ['cash']).get('cach')).toEqual([]);
  });

  test('respects the length band and max distance', () => {
    const expansions = expandFuzzyTokens(['cache'], ['ca', 'caché', 'puntaroca']);
    expect(expansions.get('cache')).toEqual(['caché']);
  });

  test('caps expansions deterministically and sorts matches', () => {
    // The precondition is unique + default-sorted: the caller supplies it, as
    // globalVocabulary() does (production no longer re-copies/re-sorts).
    const vocabulary = Array.from({ length: 60 }, (_v, i) => `hello${i}`).sort();
    const expansions = expandFuzzyTokens(['hello'], vocabulary);
    const terms = expansions.get('hello')!;
    expect(terms.length).toBe(FUZZY_MAX_EXPANSIONS);
    expect(terms).toEqual([...terms].sort());

    const small = expandFuzzyTokens(['hello'], vocabulary, 10);
    expect(small.get('hello')!.length).toBe(10);
    expect(expandFuzzyTokens(['hello'], vocabulary)).toEqual(
      expandFuzzyTokens(['hello'], vocabulary)
    );
  });

  test('does not expand sub-trigram query tokens', () => {
    expect(expandFuzzyTokens(['ab'], ['ab', 'ax']).get('ab')).toEqual([]);
  });
});

describe('expandFuzzyTokens — shared-vocabulary safety (P-A precondition)', () => {
  test('does not mutate a frozen unique+sorted vocabulary and is repeatable', () => {
    // The production caller passes the shared, cached vocabulary array; the
    // function must never copy, re-sort or mutate it. A frozen array makes any
    // in-place mutation throw (ESM strict mode).
    const vocabulary = Object.freeze(['cache', 'puntaroca', 'ca', 'caché'].sort());
    const before = [...vocabulary];
    const first = expandFuzzyTokens(['cache', 'puntaroca'], vocabulary);
    const second = expandFuzzyTokens(['cache', 'puntaroca'], vocabulary);

    expect(second).toEqual(first);
    expect([...vocabulary]).toEqual(before); // input untouched
    expect(vocabulary).toEqual([...vocabulary].sort()); // precondition holds
  });

  test('expansions are identical to the legacy copy/sort implementation (500+ tokens)', () => {
    // Differential test: production (no normalization) vs the pre-change
    // implementation (normalizes internally), over a broad fixture sample.
    const vocabulary = fixtureVocabulary();
    const tokens = buildTokenSample(vocabulary, 600);

    expect(vocabulary).toEqual([...new Set(vocabulary)].sort()); // sorted + unique
    expect(tokens.length).toBeGreaterThanOrEqual(500);

    let compared = 0;
    for (const token of tokens) {
      const actual = expandFuzzyTokens([token], vocabulary).get(token)!;
      const legacy = legacyExpandFuzzyTokens([token], vocabulary).get(token)!;
      expect(actual).toEqual(legacy);
      compared += 1;
    }
    expect(compared).toBe(tokens.length);

    // The shared expansion budget interacts across tokens: order must match too.
    const multi = tokens.slice(0, 8);
    expect(expandFuzzyTokens(multi, vocabulary)).toEqual(
      legacyExpandFuzzyTokens(multi, vocabulary)
    );
  });
});

describe('foldedVocabulary — production vocabulary invariant (P-A)', () => {
  test('returns a unique, default-sorted array equal to [...new Set(terms)].sort()', () => {
    const terms = foldedVocabulary(FIXTURE_CORPUS);
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms).toEqual([...terms].sort());
    expect(terms).toEqual([...new Set(terms)].sort());
  });

  test('folds diacritics and keeps both raw and tokenized words', () => {
    const terms = foldedVocabulary([{ name: 'Configuración-tempHP', content: 'acción CaFe' }]);
    expect(terms).toContain('configuracion'); // diacritics folded
    expect(terms).toContain('temp'); // tokenizer sub-word of "tempHP"
    expect(terms).toContain('cafe'); // folded raw word
    expect(terms).toEqual([...terms].sort());
  });
});

describe('MindStore — fuzzy channel (P-A global vocabulary)', () => {
  test('recovers a typo past the first three characters of a word', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'emb', 'embeddings provider', { tags: ['test'] });

    const results = (await store.search('embeddigs')) as ScoredSearchResult[];
    expect(names(results)).toEqual(['emb']);
    expect(results[0]!.methods).toContain('fuzzy');
    store.cleanup();
  });

  test('a first-3-character typo is not recovered (documented P-A limitation)', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'emb', 'embeddings provider', { tags: ['test'] });

    expect(await store.search('xmbeddings')).toEqual([]);
    store.cleanup();
  });

  test('tolerates transposition, insertion and deletion typos', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'transp', 'puntaroca settlement', { tags: ['test'] });
    await store.addMemory('test', 'ins', 'embeddings provider', { tags: ['test'] });
    await store.addMemory('test', 'del', 'memory token', { tags: ['test'] });

    expect(names(await store.search('puntroca'))).toEqual(['transp']); // transposition
    expect(names(await store.search('embeddigs'))).toEqual(['ins']); // insertion
    expect(names(await store.search('memry'))).toEqual(['del']); // deletion
    store.cleanup();
  });

  test('recovers ES and EN typos with diacritic folding', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'es', 'configuración sistema', { tags: ['test'] });
    await store.addMemory('test', 'en', 'configuration service', { tags: ['test'] });

    expect(names(await store.search('sistama'))).toEqual(['es']);
    expect(names(await store.search('servise'))).toEqual(['en']);
    store.cleanup();
  });

  test('recovers a typo inside a camelCase identifier', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'ident', 'handleSearchResults helper', { tags: ['test'] });

    expect(names(await store.search('handleSearchReslts'))).toEqual(['ident']);
    store.cleanup();
  });

  test('finds a typo of a token buried in a long memory', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const filler = Array.from({ length: 200 }, (_v, i) => `word${i}`).join(' ');
    await store.addMemory('test', 'long', `${filler} zephyrion signal ${filler}`, {
      tags: ['test'],
    });

    expect(names(await store.search('zephyrian'))).toEqual(['long']);
    store.cleanup();
  });

  test('multi-term query recovers a typo while requiring token coverage', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'both', 'configuracion red', { tags: ['test'] });
    await store.addMemory('test', 'partial', 'configuracion blue', { tags: ['test'] });

    const results = await store.search('confguracion red');
    expect(names(results)).toEqual(['both']);
    store.cleanup();
  });

  test('returns no noise for an unrelated query', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'configuración sistema', { tags: ['test'] });

    expect(await store.search('zzzzqqqq')).toEqual([]);
    store.cleanup();
  });

  test('repeated fuzzy searches are deterministic', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'configuración sistema', { tags: ['test'] });
    await store.addMemory('test', 'b', 'configuracion agente', { tags: ['test'] });

    const project = (results: ScoredSearchResult[]) =>
      results.map(result => ({ name: result.name, score: result.score, methods: result.methods }));
    expect(JSON.stringify(project(await store.search('confguracion sistem')))).toBe(
      JSON.stringify(project(await store.search('confguracion sistem')))
    );
    store.cleanup();
  });
});

describe('P-A vocabulary cache invalidation', () => {
  test('a term added after the cache is primed is findable by typo', async () => {
    const store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'alpha content', { tags: ['test'] });
    // Prime the per-store fuzzy vocabulary cache.
    expect(names(await store.search('alpha'))).toEqual(['a']);

    // A term added after the cache is primed must be findable by typo: the write
    // bumped the store generation, so the vocabulary cache is reloaded.
    await store.addMemory('test', 'b', 'zephyrion signal', { tags: ['test'] });
    expect(names(await store.search('zephyrian'))).toContain('b');
    store.cleanup();
  });
});
