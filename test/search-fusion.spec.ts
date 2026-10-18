// ── Search fusion (D4) + confidence (D5) + semantic breaker (D7) ──
//
// Unit coverage for the pure fusion math (normalization guards, agreement
// bonus, deterministic ordering), the confidence bucket rules, token-set math
// and the admission predicate, plus store-level checks that the semantic
// channel is omitted when RAG is off and skipped while the semantic breaker is
// open after a provider failure.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { CONFIG } from '../src/config';
import * as ragHelpers from '../src/helpers/rag';
import type { ScoredSearchResult } from '../src/store/repositories/search-repository';
import {
  AGREEMENT_BONUS_CAP,
  AGREEMENT_BONUS_PER_CHANNEL,
  HIGH_CONFIDENCE_SCORE_FLOOR,
  MORPH_MIN_PREFIX_LENGTH,
  SEARCH_CHANNEL_WEIGHTS,
  SEMANTIC_MEDIUM_FLOOR,
  computeConfidence,
  countCoveredQueryTokens,
  documentSatisfiesQuery,
  fuseCandidates,
  normalizeChannelScores,
  parseQuery,
  tokenSetScore,
  type ChannelScores,
} from '../src/store/shared';

import { createTestStore } from './mocks/test-store';

interface Doc {
  id: string;
  name: string;
}

const doc = (id: string, name: string = id): Doc => ({ id, name });

describe('normalizeChannelScores', () => {
  test('an empty channel yields an empty map (the channel is absent)', () => {
    expect(normalizeChannelScores(new Map()).size).toBe(0);
  });

  test('an all-equal channel contributes 1.0 to every candidate', () => {
    const normalized = normalizeChannelScores(
      new Map([
        ['a', 5],
        ['b', 5],
      ])
    );
    expect(normalized.get('a')).toBe(1);
    expect(normalized.get('b')).toBe(1);
  });

  test('min-max normalizes spread scores into 0..1', () => {
    const normalized = normalizeChannelScores(
      new Map([
        ['a', 0],
        ['b', 5],
        ['c', 10],
      ])
    );
    expect(normalized.get('a')).toBe(0);
    expect(normalized.get('b')).toBeCloseTo(0.5, 10);
    expect(normalized.get('c')).toBe(1);
  });

  test('non-finite scores are coerced to zero (no NaN propagation)', () => {
    const normalized = normalizeChannelScores(
      new Map([
        ['a', Number.NaN],
        ['b', 1],
      ])
    );
    expect(normalized.get('a')).toBe(0);
    expect(normalized.get('b')).toBe(1);
  });
});

describe('fuseCandidates — agreement bonus', () => {
  test('adds a fixed bonus per extra channel', () => {
    const channels: ChannelScores[] = [
      // Both candidates share the phrase channel with equal scores (=> 1.0).
      {
        method: 'phrase',
        scores: new Map([
          ['a', 1],
          ['b', 1],
        ]),
      },
      { method: 'all', scores: new Map([['a', 1]]) },
      { method: 'any', scores: new Map([['a', 1]]) },
    ];
    const fused = fuseCandidates([doc('a'), doc('b')], channels);
    const a = fused.find(result => result.item.id === 'a')!;
    const b = fused.find(result => result.item.id === 'b')!;

    expect(a.fusedScore).toBeCloseTo(
      SEARCH_CHANNEL_WEIGHTS.phrase +
        SEARCH_CHANNEL_WEIGHTS.all +
        SEARCH_CHANNEL_WEIGHTS.any +
        2 * AGREEMENT_BONUS_PER_CHANNEL,
      10
    );
    expect(b.fusedScore).toBeCloseTo(SEARCH_CHANNEL_WEIGHTS.phrase, 10);
    expect(fused[0]!.item.id).toBe('a');
  });

  test('caps the agreement bonus at its configured maximum', () => {
    const channels: ChannelScores[] = [
      { method: 'phrase', scores: new Map([['a', 1]]) },
      { method: 'all', scores: new Map([['a', 1]]) },
      { method: 'any', scores: new Map([['a', 1]]) },
      { method: 'trigram', scores: new Map([['a', 1]]) },
      { method: 'fuzzy', scores: new Map([['a', 1]]) },
    ];
    const expectedWeights =
      SEARCH_CHANNEL_WEIGHTS.phrase +
      SEARCH_CHANNEL_WEIGHTS.all +
      SEARCH_CHANNEL_WEIGHTS.any +
      SEARCH_CHANNEL_WEIGHTS.trigram +
      SEARCH_CHANNEL_WEIGHTS.fuzzy;

    const fused = fuseCandidates([doc('a')], channels);
    expect(fused[0]!.fusedScore).toBeCloseTo(expectedWeights + AGREEMENT_BONUS_CAP, 10);
    // Four extra channels would be 0.20 uncapped; the cap keeps it at 0.15.
    expect(4 * AGREEMENT_BONUS_PER_CHANNEL).toBeGreaterThan(AGREEMENT_BONUS_CAP);
  });
});

describe('fuseCandidates — deterministic ordering and provenance', () => {
  test('equal-score results order by name then id and repeat identically', () => {
    const candidates = [doc('3', 'alpha'), doc('1', 'beta'), doc('2', 'alpha')];
    const channels: ChannelScores[] = [
      {
        method: 'phrase',
        scores: new Map([
          ['3', 1],
          ['1', 1],
          ['2', 1],
        ]),
      },
    ];
    const first = fuseCandidates(candidates, channels).map(result => result.item.id);
    const second = fuseCandidates([...candidates].reverse(), channels).map(
      result => result.item.id
    );

    expect(first).toEqual(['2', '3', '1']);
    expect(second).toEqual(first);
    expect(fuseCandidates(candidates, channels)[0]!.score).toBe(1);
  });

  test('provenance is ordered by fixed channel precedence', () => {
    const channels: ChannelScores[] = [
      { method: 'fuzzy', scores: new Map([['a', 1]]) },
      { method: 'phrase', scores: new Map([['a', 1]]) },
      { method: 'trigram', scores: new Map([['a', 1]]) },
    ];
    expect(fuseCandidates([doc('a')], channels)[0]!.methods).toEqual([
      'phrase',
      'trigram',
      'fuzzy',
    ]);
  });

  test('captures the semantic score and provenance from the semantic channel', () => {
    const channels: ChannelScores[] = [{ method: 'semantic', scores: new Map([['a', 0.8]]) }];
    const fused = fuseCandidates([doc('a')], channels);
    expect(fused[0]!.methods).toEqual(['semantic']);
    expect(fused[0]!.semanticScore).toBeCloseTo(0.8, 10);
    expect(fused[0]!.confidence).toBe('medium');
  });
});

describe('computeConfidence', () => {
  test('strong lexical matches are high only at/above the score floor', () => {
    expect(computeConfidence(['phrase'], HIGH_CONFIDENCE_SCORE_FLOOR)).toBe('high');
    expect(computeConfidence(['all'], 1)).toBe('high');
    expect(computeConfidence(['phrase'], HIGH_CONFIDENCE_SCORE_FLOOR - 0.01)).toBe('medium');
  });

  test('relaxed/substring-only lexical matches are medium', () => {
    expect(computeConfidence(['any'], 1)).toBe('medium');
    expect(computeConfidence(['trigram'], 1)).toBe('medium');
    expect(computeConfidence(['like'], 1)).toBe('medium');
    expect(computeConfidence(['token_set'], 1)).toBe('medium');
  });

  test('fuzzy-only and channel-less matches are low', () => {
    expect(computeConfidence(['fuzzy'], 1)).toBe('low');
    expect(computeConfidence([], 1)).toBe('low');
  });

  test('semantic-only confidence tracks the semantic score floor', () => {
    expect(computeConfidence(['semantic'], 0.5, SEMANTIC_MEDIUM_FLOOR)).toBe('medium');
    expect(computeConfidence(['semantic'], 0.5, SEMANTIC_MEDIUM_FLOOR - 0.01)).toBe('low');
    expect(computeConfidence(['semantic'], 0.5)).toBe('low');
  });
});

describe('tokenSetScore', () => {
  test('equals the fraction of distinct query tokens present', () => {
    expect(tokenSetScore(['a', 'b', 'c', 'd'], ['a', 'b', 'c'])).toBe(0.75);
    expect(tokenSetScore(['a', 'a', 'b'], ['a'])).toBe(0.5);
    expect(tokenSetScore(['a'], ['a', 'b'])).toBe(1);
    expect(tokenSetScore([], ['a'])).toBe(0);
  });
});

describe('documentSatisfiesQuery / countCoveredQueryTokens', () => {
  test('matches exact folded substrings', () => {
    expect(documentSatisfiesQuery(parseQuery('config'), 'configuration', 'settings')).toBe(true);
    expect(documentSatisfiesQuery(parseQuery('configuracion'), 'Configuración', '')).toBe(true);
  });

  test('tolerates conservative inflections via a shared prefix', () => {
    expect(MORPH_MIN_PREFIX_LENGTH).toBeGreaterThanOrEqual(3);
    expect(documentSatisfiesQuery(parseQuery('ogros'), 'ogro', 'text')).toBe(true);
  });

  test('does not collapse unrelated words that merely share a prefix', () => {
    // The exact regression the mutual-prefix morphology was introduced for.
    expect(documentSatisfiesQuery(parseQuery('formanc'), 'formato', '')).toBe(false);
  });

  test('honours prefix nodes and OR groups', () => {
    expect(documentSatisfiesQuery(parseQuery('type*'), 'typedef', '')).toBe(true);
    expect(documentSatisfiesQuery(parseQuery('alpha OR beta'), 'nothing', 'beta here')).toBe(true);
  });

  test('an empty query admits nothing', () => {
    expect(documentSatisfiesQuery(parseQuery('   '), 'anything', 'anything')).toBe(false);
  });

  test('counts distinct covered query tokens with morphology', () => {
    expect(countCoveredQueryTokens(['alpha', 'beta', 'gamma'], 'alpha doc', 'beta here')).toBe(2);
    expect(countCoveredQueryTokens(['ogros'], 'ogro', '')).toBe(1);
    expect(countCoveredQueryTokens(['formanc'], 'formato', '')).toBe(0);
  });
});

describe('semantic channel gating (store level)', () => {
  let store: ReturnType<typeof createTestStore> | null = null;
  const restorers: (() => void)[] = [];

  afterEach(() => {
    store?.cleanup();
    store = null;
    for (const restore of restorers.splice(0)) restore();
    ragHelpers.resetSemanticBreaker();
  });

  test('RAG disabled omits the semantic channel silently', async () => {
    const ragSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(false);
    restorers.push(() => ragSpy.mockRestore());

    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'cfg', 'configuration settings', { tags: ['test'] });

    const results = (await store.search('configuration')) as ScoredSearchResult[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(result => !result.methods.includes('semantic'))).toBe(true);
  });

  test('semantic is skipped while the breaker is open after a failure', async () => {
    const ragSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(true);
    restorers.push(() => ragSpy.mockRestore());
    const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue([]);
    restorers.push(() => semanticSpy.mockRestore());

    store = createTestStore();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'cfg', 'configuration settings', { tags: ['test'] });
    semanticSpy.mockResolvedValue([{ id: mem.id, score: 0.9 }]);

    ragHelpers.resetSemanticBreaker();
    await store.search('configuration', { space: 'test' });
    expect(semanticSpy).toHaveBeenCalledTimes(1);

    ragHelpers.recordSemanticFailure();
    await store.search('configuration', { space: 'test' });
    expect(semanticSpy).toHaveBeenCalledTimes(1);
  });

  test('the semantic breaker TTL is respected and reset closes it', () => {
    ragHelpers.resetSemanticBreaker();
    expect(ragHelpers.isSemanticBreakerOpen(1000)).toBe(false);

    ragHelpers.recordSemanticFailure(1000, 5000);
    expect(ragHelpers.isSemanticBreakerOpen(1000)).toBe(true);
    expect(ragHelpers.isSemanticBreakerOpen(5999)).toBe(true);
    expect(ragHelpers.isSemanticBreakerOpen(6000)).toBe(false);

    ragHelpers.resetSemanticBreaker();
    expect(ragHelpers.isSemanticBreakerOpen(1000)).toBe(false);
  });

  test('a failing provider yields no embedding and opens the breaker', async () => {
    const savedRag = { ...CONFIG.rag };
    CONFIG.rag.enabled = true;
    CONFIG.rag.provider = null;
    CONFIG.rag.openaiApiKey = 'test-key';
    restorers.push(() => Object.assign(CONFIG.rag, savedRag));

    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    restorers.push(() => fetchSpy.mockRestore());
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    restorers.push(() => warnSpy.mockRestore());
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    restorers.push(() => errorSpy.mockRestore());

    ragHelpers.resetSemanticBreaker();
    expect(ragHelpers.isSemanticBreakerOpen()).toBe(false);

    const embedding = await ragHelpers.getEmbedding('hello');
    expect(embedding).toBeNull();
    expect(ragHelpers.isSemanticBreakerOpen()).toBe(true);
  }, 15000);
});
