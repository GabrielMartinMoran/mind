// ── Diagnostics sink: byte-equivalence + content-free payload ──
//
// The optional `MIND_SEARCH_DIAG` sink in `search-repository.ts` must:
//   (a) leave the current engine's results byte-identical when off vs on;
//   (b) produce identical results when on (only counts/timings are added);
//   (c) never carry memory content, names, or query text.
//
// This suite is deliberately engine-version-agnostic: it compares the sink ON
// against the sink OFF on the *same* (current) engine instead of pinning
// historical baseline hashes. The frozen v1 / historical-v2 / optimized-v2
// baselines are owned by `search-eval.spec.ts` and `search-scenarios.spec.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  setSearchDiagnosticsSink,
  type SearchDiagnostics,
} from '../src/store/repositories/search-repository';

import { runFixture, runFixtureV2, seedV2Store } from './search-eval/evaluator';
import type { FixtureSnapshot, FixtureSnapshotV2 } from './search-eval/evaluator';

describe('search diagnostics sink', () => {
  let v1Off: { snapshot: FixtureSnapshot };
  let v2Off: { snapshot: FixtureSnapshotV2 };

  beforeAll(async () => {
    setSearchDiagnosticsSink(null);
    v1Off = await runFixture();
    v2Off = await runFixtureV2();
  });

  afterAll(() => {
    setSearchDiagnosticsSink(null);
  });

  test('sink on: v2 snapshot is byte-identical to sink off on the same engine', async () => {
    const collected: SearchDiagnostics[] = [];
    setSearchDiagnosticsSink(diagnostics => collected.push(diagnostics));
    let v2On: { snapshot: FixtureSnapshotV2 };
    try {
      v2On = await runFixtureV2();
    } finally {
      setSearchDiagnosticsSink(null);
    }

    expect(v2On.snapshot.hash).toBe(v2Off.snapshot.hash);
    // Explicit refs + order equivalence (hash equality already implies this).
    const offTopk = v2Off.snapshot.cases.map(evalCase => evalCase.topk);
    const onTopk = v2On.snapshot.cases.map(evalCase => evalCase.topk);
    expect(onTopk).toEqual(offTopk);
    // Full per-case `results` (refs + methods + confidence + score) equivalence.
    const offResults = v2Off.snapshot.cases.map(evalCase => evalCase.results);
    const onResults = v2On.snapshot.cases.map(evalCase => evalCase.results);
    expect(onResults).toEqual(offResults);
    expect(collected.length).toBeGreaterThan(0);
  });

  test('sink on: v1 snapshot is byte-identical to sink off on the same engine', async () => {
    const collected: SearchDiagnostics[] = [];
    setSearchDiagnosticsSink(diagnostics => collected.push(diagnostics));
    let v1On: { snapshot: FixtureSnapshot };
    try {
      v1On = await runFixture();
    } finally {
      setSearchDiagnosticsSink(null);
    }

    expect(v1On.snapshot.hash).toBe(v1Off.snapshot.hash);
    const offTopk = v1Off.snapshot.cases.map(evalCase => evalCase.topk);
    const onTopk = v1On.snapshot.cases.map(evalCase => evalCase.topk);
    expect(onTopk).toEqual(offTopk);
    expect(collected.length).toBeGreaterThan(0);
  });

  test('sink payloads expose counts/timings with the expected keys', async () => {
    const store = await seedV2Store();
    const collected: SearchDiagnostics[] = [];
    try {
      const off = await store.search('configuracion', {});
      setSearchDiagnosticsSink(diagnostics => collected.push(diagnostics));
      const on = await store.search('configuracion', {});
      setSearchDiagnosticsSink(null);

      expect(on.length).toBeGreaterThan(0);
      expect(JSON.stringify(on)).toBe(JSON.stringify(off));
      expect(collected.length).toBe(1);

      const diagnostics = collected[0]!;
      expect(Array.isArray(diagnostics.channels)).toBe(true);
      expect(diagnostics.channels.length).toBeGreaterThan(0);
      for (const channel of diagnostics.channels) {
        expect(typeof channel.channel).toBe('string');
        expect(channel.ms).toBeGreaterThanOrEqual(0);
        expect(channel.candidates).toBeGreaterThanOrEqual(0);
      }
      expect(diagnostics.fuzzy_expansions).toBeGreaterThanOrEqual(0);
      expect(typeof diagnostics.fuzzy_cache_rebuilt).toBe('boolean');
      expect(typeof diagnostics.data_version).toBe('number');
      expect(diagnostics.data_version).toBeGreaterThanOrEqual(0);
      expect(diagnostics.admission.kept).toBeGreaterThanOrEqual(0);
      expect(diagnostics.admission.dropped).toBeGreaterThanOrEqual(0);
      expect(diagnostics.total_candidates).toBeGreaterThanOrEqual(diagnostics.admission.kept);
      expect(diagnostics.total_ms).toBeGreaterThanOrEqual(0);
    } finally {
      setSearchDiagnosticsSink(null);
      store.cleanup();
    }
  });

  test('sink payloads never carry query or content text', async () => {
    const store = await seedV2Store();
    const collected: SearchDiagnostics[] = [];
    try {
      setSearchDiagnosticsSink(diagnostics => collected.push(diagnostics));
      await store.search('configuracion puntuacion', {});
      setSearchDiagnosticsSink(null);

      expect(collected.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(collected);
      expect(serialized).not.toContain('configuracion');
      expect(serialized).not.toContain('puntuacion');
      expect(serialized).not.toContain('guia-configuracion');
      expect(serialized).not.toContain('::');
    } finally {
      setSearchDiagnosticsSink(null);
      store.cleanup();
    }
  });
});
