// ── Independent semantic admission (D1) ──
//
// A semantic-only candidate at/above the semantic admission floor must reach
// fusion even when lexical candidates already satisfy the query. The bypass is
// restricted to natural-language queries, and the lexical admission ladder must
// keep operating on lexical rows only so RAG-off behavior is byte-identical.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import * as ragHelpers from '../src/helpers/rag';
import { parseQuery } from '../src/store/shared/query-parser';
import {
  canBypassLexicalAdmission,
  selectSemanticAdmittedIds,
  SEMANTIC_ADMISSION_FLOOR,
} from '../src/store/shared/semantic-admission';

import { createTestStore } from './mocks/test-store';

type TestStore = ReturnType<typeof createTestStore>;

let store: TestStore | null = null;
const restorers: (() => void)[] = [];

function restoreAll(): void {
  for (const restore of restorers.splice(0)) restore();
  ragHelpers.resetSemanticBreaker();
}

function enableRag(entries: [id: string, score: number][]): ReturnType<typeof spyOn> {
  const ragSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(true);
  const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue(
    entries.map(([id, score]) => ({ id, score }))
  );
  restorers.push(
    () => semanticSpy.mockRestore(),
    () => ragSpy.mockRestore()
  );
  return semanticSpy;
}

function seedStore(): TestStore {
  const created = createTestStore();
  created.createSpace('test', 'Test space', ['test']);
  created.createSpace('other', 'Other space', ['test']);
  return created;
}

afterEach(() => {
  store?.cleanup();
  store = null;
  restoreAll();
});

describe('semantic admission policy (unit)', () => {
  test('only candidates at or above the admission floor are selected', () => {
    expect(SEMANTIC_ADMISSION_FLOOR).toBe(0.6);

    const scores = new Map([
      ['weak', 0.4],
      ['boundary', 0.6],
      ['strong', 0.72],
    ]);
    expect(selectSemanticAdmittedIds(scores, new Set())).toEqual(['boundary', 'strong']);
    expect(selectSemanticAdmittedIds(scores, new Set(['strong']))).toEqual(['boundary']);
  });

  test('only a single plain-term group without excludes allows the bypass', () => {
    expect(canBypassLexicalAdmission(parseQuery('authentication token'))).toBe(true);
    expect(canBypassLexicalAdmission(parseQuery('"authentication token"'))).toBe(false);
    expect(canBypassLexicalAdmission(parseQuery('authent*'))).toBe(false);
    expect(canBypassLexicalAdmission(parseQuery('authentication OR token'))).toBe(false);
    expect(canBypassLexicalAdmission(parseQuery('authentication token NOT legacy'))).toBe(false);
  });
});

describe('semantic admission (store integration)', () => {
  test('admits a paraphrase-only memory alongside lexical results', async () => {
    store = seedStore();
    await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    enableRag([[paraphrase.id, 0.72]]);

    const results = await store.search('authentication token', { space: 'test' });
    const names = results.map(result => result.name);

    expect(names).toContain('auth-guide');
    const admitted = results.find(result => result.name === 'session-recovery');
    expect(admitted).toBeDefined();
    expect(admitted!.methods).toContain('semantic');
  });

  test('respects space, tier, and tag filters for semantic candidates', async () => {
    store = seedStore();
    await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const outOfSpace = await store.addMemory(
      'other',
      'other-space',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    const outOfTier = await store.addMemory(
      'test',
      'other-tier',
      'renew signed credentials after expiry',
      { tags: ['test'], tier: 3 }
    );
    const outOfTag = await store.addMemory(
      'test',
      'other-tag',
      'renew signed credentials after expiry',
      { tags: ['other-tag'] }
    );
    enableRag([
      [outOfSpace.id, 0.9],
      [outOfTier.id, 0.9],
      [outOfTag.id, 0.9],
    ]);

    const results = await store.search('authentication token', {
      space: 'test',
      tier: 2,
      tag: 'test',
    });
    const names = results.map(result => result.name);

    expect(names).toContain('auth-guide');
    expect(names).not.toContain('other-space');
    expect(names).not.toContain('other-tier');
    expect(names).not.toContain('other-tag');
  });

  test('explicit query operators keep lexical admission', async () => {
    store = seedStore();
    await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );

    const queries = [
      'authentication token NOT legacy',
      '"authentication token"',
      'authentication OR token',
      'authent*',
    ];
    for (const query of queries) {
      enableRag([[paraphrase.id, 0.9]]);
      const results = await store.search(query, { space: 'test' });
      const names = results.map(result => result.name);
      expect(names).toContain('auth-guide');
      expect(names).not.toContain('session-recovery');
      restoreAll();
    }
  });

  test('RAG off leaves the lexical result set unchanged', async () => {
    store = seedStore();
    await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );

    const baseline = await store.search('authentication token', { space: 'test' });

    const ragSpy = spyOn(ragHelpers, 'isRagEnabled').mockReturnValue(false);
    restorers.push(() => ragSpy.mockRestore());
    const semanticSpy = spyOn(ragHelpers, 'semanticSearch').mockResolvedValue([
      { id: paraphrase.id, score: 0.9 },
    ]);
    restorers.push(() => semanticSpy.mockRestore());

    const results = await store.search('authentication token', { space: 'test' });

    expect(semanticSpy).not.toHaveBeenCalled();
    expect(results.map(result => result.name)).not.toContain('session-recovery');
    expect(results).toEqual(baseline);
  });

  test('a memory found by both channels appears once with both methods', async () => {
    store = seedStore();
    const authGuide = await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    enableRag([
      [authGuide.id, 0.9],
      [paraphrase.id, 0.7],
    ]);

    const results = await store.search('authentication token', { space: 'test' });
    const matches = results.filter(result => result.name === 'auth-guide');

    expect(matches).toHaveLength(1);
    expect(matches[0]!.methods).toContain('semantic');
    expect(matches[0]!.methods).toContain('phrase');
  });

  test('an open semantic breaker skips semantic admission', async () => {
    store = seedStore();
    await store.addMemory('test', 'auth-guide', 'authentication token rotation', {
      tags: ['test'],
    });
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    const semanticSpy = enableRag([[paraphrase.id, 0.9]]);
    ragHelpers.recordSemanticFailure();

    const results = await store.search('authentication token', { space: 'test' });
    const names = results.map(result => result.name);

    expect(semanticSpy).not.toHaveBeenCalled();
    expect(names).toContain('auth-guide');
    expect(names).not.toContain('session-recovery');
  });

  test('without lexical rows, a semantic candidate below the floor is not admitted', async () => {
    store = seedStore();
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    enableRag([[paraphrase.id, 0.4]]);

    const results = await store.search('authentication token', { space: 'test' });

    expect(results).toEqual([]);
  });

  test('without lexical rows, a semantic candidate at the floor is admitted', async () => {
    store = seedStore();
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );
    enableRag([[paraphrase.id, 0.6]]);

    const results = await store.search('authentication token', { space: 'test' });

    expect(results.map(result => result.name)).toEqual(['session-recovery']);
    expect(results[0]!.methods).toContain('semantic');
  });

  test('without lexical rows, explicit operators never admit semantic candidates', async () => {
    store = seedStore();
    const paraphrase = await store.addMemory(
      'test',
      'session-recovery',
      'renew signed credentials after expiry',
      { tags: ['test'] }
    );

    const queries = [
      '"authentication token"',
      'authentication OR token',
      'authent*',
      'authentication token NOT legacy',
    ];
    for (const query of queries) {
      enableRag([[paraphrase.id, 0.9]]);
      const results = await store.search(query, { space: 'test' });
      expect(results).toEqual([]);
      restoreAll();
    }
  });

  test('a high-score semantic candidate excluded by NOT is absent', async () => {
    store = seedStore();
    const paraphrase = await store.addMemory(
      'test',
      'legacy-session',
      'renew signed credentials after expiry deprecated',
      { tags: ['test'] }
    );
    enableRag([[paraphrase.id, 0.9]]);

    const results = await store.search('authentication token NOT deprecated', {
      space: 'test',
    });

    expect(results.map(result => result.name)).not.toContain('legacy-session');
  });
});
