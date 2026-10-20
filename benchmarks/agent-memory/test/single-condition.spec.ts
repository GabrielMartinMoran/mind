// Single-condition regression (T7a scope change): the pilot runs ONLY
// `mind-v10`. These tests prove aggregation and the report generator handle a
// one-condition run gracefully — v9↔v10 diffs and the no-memory comparison
// degrade to empty/n/a, unrun stages are `not_run`, and nothing crashes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { loadRunSummary, renderSummaryTable } from '../src/metrics/aggregate';
import { generateReport } from '../src/report';

import { makeA1, makeA2, writeFixtureRun } from './fixtures/bench-run';

/** A run with only the `mind-v10` condition (A1 + A2), no B stages. */
function v10OnlyRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-single-'));
  writeFixtureRun(dir, {
    a1: {
      'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.25, latencyP50Ms: 20, contextTokensAt25: 971 }),
    },
    a2: { 'mind-v10': [makeA2('mind-v10', 'conv-26#1', 'correct', { judgeScore: 0.9, f1: 0.8 })] },
  });
  return dir;
}

describe('single-condition run (mind-v10 only)', () => {
  test('buildSummary yields no v9↔v10 diffs and no mind-vs-no-memory rows', () => {
    const summary = loadRunSummary(v10OnlyRunDir());
    expect(summary.conditions['mind-v10']!.a1).not.toBeNull();
    expect(summary.conditions['mind-v10']!.a2).not.toBeNull();
    expect(summary.conditions['mind-v9']!.a1).toBeNull();
    expect(summary.conditions['no-memory']!.a2).toBeNull();
    expect(summary.diffs.a1).toEqual([]);
    expect(summary.diffs.a2).toEqual([]);
    expect(summary.diffs.b).toEqual([]);
    // The no-memory / v9 baselines are absent, so those cells are n/a (null),
    // but the v10 measurements are still reported.
    expect(summary.diffs.mindVsNoMemory.length).toBeGreaterThan(0);
    for (const row of summary.diffs.mindVsNoMemory) {
      expect(row.noMemory).toBeNull();
      expect(row.mindV9).toBeNull();
    }
    expect(summary.missingStages).toContain('b');
    expect(summary.notes).toContain('b: not_run');
  });

  test('renderSummaryTable shows n/a for absent conditions without crashing', () => {
    const table = renderSummaryTable(loadRunSummary(v10OnlyRunDir()));
    expect(table).toContain('mind-v10');
    expect(table).toContain('n/a');
  });

  test('generateReport handles a single condition gracefully', () => {
    const report = generateReport({ runDir: v10OnlyRunDir() });
    expect(report).toContain('mind-v10');
    expect(report).toContain('not_run');
    // The v9↔v10 diff blocks report not_run rather than inventing numbers.
    expect(report).toContain('_not_run_');
    // Mind-v10 A1 numbers are still injected.
    expect(report).toContain('0.500');
  });
});
