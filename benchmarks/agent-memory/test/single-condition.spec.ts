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

import { makeA1, makeA2, makeMeta, makeScenario, writeFixtureRun } from './fixtures/bench-run';

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

/** A run with only the default `mind-current` condition (A1 + A2 + B). */
function currentOnlyRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-single-current-'));
  writeFixtureRun(dir, {
    meta: {
      ...makeMeta(),
      current: {
        branch: 'feat/test-branch',
        headSha: 'abc1234',
        dirty: false,
        packageVersion: '0.1.0-test',
        schemaVersion: 10,
        mindBinary: '/opt/mind/mind',
      },
    },
    a1: {
      'mind-current': makeA1({ hitAt5: 0.6, mrr: 0.35, latencyP50Ms: 18, contextTokensAt25: 800 }),
    },
    a2: {
      'mind-current': [
        makeA2('mind-current', 'conv-26#1', 'correct', { judgeScore: 0.9, f1: 0.8 }),
      ],
    },
    b: {
      'mind-current': [makeScenario('mind-current', 'b1', true, { memoryCalls: 2 })],
    },
  });
  return dir;
}

describe('single-condition run (mind-current only)', () => {
  test('data-level summary activates current and invents no historical baseline', () => {
    const summary = loadRunSummary(currentOnlyRunDir());
    expect(summary.activeConditions).toEqual(['mind-current']);
    expect(summary.conditions['mind-current']!.a1).not.toBeNull();
    expect(summary.conditions['mind-current']!.a2).not.toBeNull();
    expect(summary.diffs.a2Baseline.length).toBeGreaterThan(0);
    for (const row of summary.diffs.a2Baseline) {
      expect(row.condition).toBe('mind-current');
      expect(row.baseline).toBeNull();
      expect(row.absolute).toBeNull();
    }
    expect(summary.diffs.mindVsNoMemory).toEqual([]);
    expect(summary.diffs.pairwise).toEqual([]);
    expect(summary.diffs.mindVsNoMemoryByCondition.length).toBeGreaterThan(0);
    for (const row of summary.diffs.mindVsNoMemoryByCondition) {
      expect(row.baseline).toBeNull();
      expect(Object.keys(row.conditions)).toEqual(['mind-current']);
    }
  });

  test('table shows current only, never a historical condition', () => {
    const table = renderSummaryTable(loadRunSummary(currentOnlyRunDir()));
    expect(table).toContain('mind-current');
    expect(table).not.toContain('mind-v9');
    expect(table).not.toContain('mind-v10');
    expect(table).not.toContain('no-memory');
  });

  test('reports absolute current metrics in A1, A2 and B without a historical baseline', () => {
    const report = generateReport({ runDir: currentOnlyRunDir() });
    // A1 injected absolute metrics.
    expect(report).toContain('| mind-current | 0.600 |');
    expect(report).toContain('0.350');
    // A2 current row (judge 0.900) and B current row.
    expect(report).toContain('| mind-current | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0.800 | 0.900 |');
    expect(report).toContain('| mind-current | 1/1 | 1.000 |');
    // No historical condition row or baseline is invented.
    expect(report).not.toContain('| mind-v9 |');
    expect(report).not.toContain('| mind-v10 |');
    expect(report).not.toContain('| no-memory |');
    expect(report).not.toContain('Mind vs sin memoria (condiciones medidas)');
    expect(report).not.toContain('Diffs v9');
  });

  test('shows current provenance and current cost, and never claims a stage did not run', () => {
    const report = generateReport({ runDir: currentOnlyRunDir() });
    expect(report).toContain('feat/test-branch');
    expect(report).toContain('abc1234');
    expect(report).toContain('dirty: no');
    expect(report).toContain('0.1.0-test');
    expect(report).toContain('/opt/mind/mind');
    // A2 + B cost from the measured current condition (not a hardcoded v10).
    expect(report).toContain('A2=`0.0010` USD');
    expect(report).toContain('B=`0.0020` USD');
    // A current A1/A2 artifact exists, so "no ejecutado" would be false.
    expect(report).not.toContain('A1 no ejecutado');
    expect(report).not.toContain('A2 no ejecutado');
    expect(report).toContain('No se seleccionó una comparación');
  });

  test('current-only prose asks for the absolute result and claims no v9↔v10 comparison', () => {
    const report = generateReport({ runDir: currentOnlyRunDir() });
    expect(report).not.toContain('¿Mejora v10 respecto de v9?');
    expect(report).toContain('¿Cuál es el resultado absoluto de la condición medida?');
    // The no-comparison statement appears once in the conclusions, not per stage.
    const conclusions = report.slice(report.indexOf('## Conclusiones'));
    expect((conclusions.match(/No se seleccionó una comparación/g) ?? []).length).toBe(1);
    // §12 only mentions the v9↔v10 caveat when both historical sides ran.
    const section12 = report.slice(report.indexOf('## 12.'), report.indexOf('## 13.'));
    expect(section12).not.toContain('Matiz v9↔v10');
    expect(section12).not.toContain('comparación pedida');
    expect(report).not.toContain('es la comparación pedida');
  });
});
