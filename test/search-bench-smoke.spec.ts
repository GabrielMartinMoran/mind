// ── Benchmark harness structural smoke test ──
//
// Verifies the harness runs on a tiny corpus and emits the expected shape
// (percentiles, classes, telemetry) without asserting absolute timings. The
// heavy scalability corpora are never touched here.

import { describe, expect, test } from 'bun:test';

import {
  buildFixtureBenchQueries,
  buildScalabilityQueries,
  cleanupDb,
  generateCorpus,
  measureLatency,
  seedStore,
  summarize,
} from '../scripts/bench-search';

describe('search bench harness (structural smoke)', () => {
  test('summary percentiles are ordered and bounded by min/max', () => {
    const summary = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary.n).toBe(10);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(10);
    expect(summary.p50).toBeLessThanOrEqual(summary.p95);
    expect(summary.p95).toBeLessThanOrEqual(summary.p99);
    expect(summary.p50).toBeGreaterThanOrEqual(summary.min);
    expect(summary.p99).toBeLessThanOrEqual(summary.max);
  });

  test('fixture queries cover the required class taxonomy', () => {
    const classes = new Set(buildFixtureBenchQueries().map(benchQuery => benchQuery.class));
    for (const key of ['exact', 'prefix', 'substring', 'typo', 'and', 'or', 'negative', 'filter']) {
      expect(classes.has(key)).toBe(true);
    }
  });

  test('scalability corpus generator is deterministic', () => {
    const first = generateCorpus(20, 7);
    const second = generateCorpus(20, 7);
    expect(first.length).toBe(20);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('bench runs on a tiny corpus and emits expected keys', async () => {
    const corpus = generateCorpus(30, 1);
    const queries = buildScalabilityQueries(corpus).slice(0, 6);
    const { store, dbPath } = await seedStore(corpus, 'smoke');
    try {
      const result = await measureLatency(store, queries, { reps: 2, warmup: 1, budgetMs: 0 });
      expect(result.measured).toBeGreaterThan(0);
      expect(Object.keys(result.by_class).length).toBeGreaterThan(0);
      expect(result.overall.n).toBeGreaterThan(0);
      expect(result.overall.p50).toBeLessThanOrEqual(result.overall.p95);
      expect(result.overall.p95).toBeLessThanOrEqual(result.overall.p99);
      expect(Array.isArray(result.telemetry.per_channel)).toBe(true);
      expect(typeof result.telemetry.total_candidates).toBe('number');
      expect(typeof result.telemetry.fuzzy_expansions).toBe('number');
      expect(typeof result.telemetry.admission_kept).toBe('number');
      expect(typeof result.telemetry.admission_dropped).toBe('number');
    } finally {
      store.close();
      cleanupDb(dbPath);
    }
  });
});
