// Aggregation tests — pure per-bucket aggregation, diffs, N/A handling and the
// I/O wrapper, all against handcrafted fixtures (our own numbers).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  aggregateA1,
  aggregateA2,
  aggregateB,
  buildSummary,
  loadRunSummary,
  renderSummaryTable,
  type RunSummary,
} from '../src/metrics/aggregate';

import { makeA1, makeA2, makeMeta, makeScenario, writeFixtureRun } from './fixtures/bench-run';

describe('aggregateA1', () => {
  test('reports cat1-4 metrics, result-count mean and search count', () => {
    const a1 = aggregateA1(makeA1({ hitAt5: 0.5, hitAt10: 0.5, mrr: 0.5, latencyP50Ms: 20 }));
    expect(a1.cat1To4.hitAt5).toBe(0.5);
    expect(a1.cat1To4.mrr).toBe(0.5);
    expect(a1.cat1To4.latencyP50Ms).toBe(20);
    expect(a1.resultCountMean).toBe(4);
    expect(a1.searchCount).toBe(2);
  });

  test('keeps cat5 adversarial separate from cat1-4', () => {
    const a1 = aggregateA1(makeA1({ hitAt5: 0.5 }));
    expect(a1.cat5Adversarial.count).toBe(1);
    expect(a1.cat1To4.count).toBe(4);
  });
});

describe('aggregateA2', () => {
  test('computes classes, F1 mean, judge mean, memory, tokens, cost and p50', () => {
    const results = [
      makeA2('mind-v10', 'q1', 'correct', {
        f1: 1,
        judgeScore: 0.9,
        memoryCalls: 2,
        latencyMs: 100,
      }),
      makeA2('mind-v10', 'q2', 'partial', {
        f1: 0.4,
        judgeScore: 0.5,
        memoryCalls: 1,
        latencyMs: 300,
      }),
    ];
    const summary = aggregateA2(results);
    expect(summary.count).toBe(2);
    expect(summary.classes.correct).toBe(1);
    expect(summary.classes.partial).toBe(1);
    expect(summary.f1Mean).toBeCloseTo(0.7, 10);
    expect(summary.judgeScoreMean).toBeCloseTo(0.7, 10);
    expect(summary.memoryCalls).toBe(3);
    expect(summary.tokensInput).toBe(20);
    expect(summary.tokensOutput).toBe(10);
    expect(summary.costUsd).toBeCloseTo(0.002, 10);
    expect(summary.latencyP50Ms).toBe(300);
  });

  test('counts cat5 abstentions and hallucinations separately', () => {
    const summary = aggregateA2([
      makeA2('mind-v10', 'q1', 'correct_abstention', { judgeScore: 1 }),
      makeA2('mind-v10', 'q2', 'hallucination', { judgeScore: 0 }),
    ]);
    expect(summary.correctAbstentions).toBe(1);
    expect(summary.hallucinations).toBe(1);
    expect(summary.f1Mean).toBeNull();
  });
});

describe('aggregateB', () => {
  test('computes task success, sub-agent transfer, tokens and p50', () => {
    const summary = aggregateB([
      makeScenario('mind-v10', 'b1', true, { memoryCalls: 1 }),
      makeScenario('mind-v10', 'b4', true, { childCount: 1, childMemoryCalls: 3, memoryCalls: 2 }),
    ]);
    expect(summary.taskSuccess).toEqual({
      passed: 2,
      failed: 0,
      total: 2,
      notRun: 0,
      rate: 1,
    });
    expect(summary.subagent).toEqual({
      expected: true,
      childCaptured: true,
      childCount: 1,
      pass: true,
    });
    expect(summary.memoryCalls).toBe(6);
    expect(summary.tokensInput).toBe(40);
    expect(summary.tokensOutput).toBe(20);
    expect(summary.latencyP50Ms).toBe(200);
  });

  test('sub-agent expected=false with no b4 scenario', () => {
    const summary = aggregateB([makeScenario('no-memory', 'b1', false)]);
    expect(summary.subagent).toEqual({
      expected: false,
      childCaptured: false,
      childCount: 0,
      pass: null,
    });
    expect(summary.taskSuccess).toEqual({
      passed: 0,
      failed: 1,
      total: 1,
      notRun: 0,
      rate: 0,
    });
  });

  test('excludes not_run scenarios from passed/failed/total and exposes the count', () => {
    const summary = aggregateB([
      makeScenario('mind-v10', 'b8', false, {
        status: 'not_run',
        notRunReason: 'requires mind-current',
      }),
    ]);
    expect(summary.taskSuccess).toEqual({
      passed: 0,
      failed: 0,
      total: 0,
      notRun: 1,
      rate: null,
    });
    expect(summary.scenarios[0]).toMatchObject({
      scenarioId: 'b8',
      pass: false,
      status: 'not_run',
      notRunReason: 'requires mind-current',
    });
  });
});

describe('buildSummary', () => {
  const base = {
    runId: 'run-test',
    meta: makeMeta(),
    a1: { 'mind-v9': makeA1({ hitAt5: 0, mrr: 0 }), 'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.5 }) },
    a2: {
      'no-memory': [makeA2('no-memory', 'q1', 'incorrect', { judgeScore: 0.1 })],
      'mind-v9': [makeA2('mind-v9', 'q1', 'partial', { judgeScore: 0.5 })],
      'mind-v10': [makeA2('mind-v10', 'q1', 'correct', { judgeScore: 0.9 })],
    },
    b: {},
    missing: ['a1:no-memory', 'b'],
  };

  test('keeps A and B separate and marks no-memory A1 as not_run', () => {
    const summary = buildSummary(base);
    expect(summary.conditions['no-memory']!.a1).toBeNull();
    expect(summary.conditions['mind-v10']!.a1).not.toBeNull();
    expect(summary.missingStages).toContain('a1:no-memory');
    expect(summary.notes).toContain('a1:no-memory: not_run');
  });

  test('emits absolute and relative v9→v10 diffs with N/A for a zero baseline', () => {
    const summary = buildSummary(base);
    const hit5 = summary.diffs.a1.find(row => row.metric === 'hitAt5')!;
    expect(hit5.v9).toBe(0);
    expect(hit5.v10).toBe(0.5);
    expect(hit5.absolute).toBeCloseTo(0.5, 10);
    expect(hit5.relative).toBeNull();
  });

  test('emits a Mind-vs-no-memory comparison for A2 when data exists', () => {
    const summary = buildSummary(base);
    const judge = summary.diffs.mindVsNoMemory.find(row => row.metric === 'a2.judgeScoreMean')!;
    expect(judge.noMemory).toBeCloseTo(0.1, 10);
    expect(judge.mindV10).toBeCloseTo(0.9, 10);
  });

  test('renders a table that names every condition', () => {
    const table = renderSummaryTable(buildSummary(base));
    expect(table).toContain('mind-v9');
    expect(table).toContain('mind-v10');
    expect(table).toContain('no-memory');
  });

  test('discloses the A1 cat1-4 evaluable denominator next to the pooled values', () => {
    const summary = buildSummary({
      ...base,
      a1: {
        'mind-v9': makeA1({ hitAt5: 0, count: 24, evidenceCount: 24 }),
        'mind-v10': makeA1({ hitAt5: 0.391, count: 24, evidenceCount: 23 }),
      },
    });
    const table = renderSummaryTable(summary);
    expect(table).toContain('Denominador evaluable A1');
    expect(table).toContain('`mind-v10` 23/24 evaluables (1 sin evidencia excluida(s))');
    expect(table).toContain('`mind-v9` 24/24 evaluables');
  });
});

describe('loadRunSummary', () => {
  test('reads an A1-only run and marks A2/B not_run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-agg-'));
    writeFixtureRun(dir, {
      a1: { 'mind-v9': makeA1({ hitAt5: 0 }), 'mind-v10': makeA1({ hitAt5: 0.5 }) },
    });
    const summary = loadRunSummary(dir);
    expect(summary.conditions['mind-v10']!.a1!.cat1To4.hitAt5).toBe(0.5);
    expect(summary.conditions['mind-v9']!.a1!.cat1To4.hitAt5).toBe(0);
    expect(summary.conditions['mind-v10']!.a2).toBeNull();
    expect(summary.missingStages).toContain('a2');
    expect(summary.missingStages).toContain('b');
    // A run without `mind-current` keeps the pre-00014 historical table layout,
    // including the explicit `n/a` rows for conditions that did not run.
    expect(renderSummaryTable(summary)).toContain(
      '| no-memory | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'
    );
  });

  test('is robust to a run with no result files at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-agg-empty-'));
    writeFixtureRun(dir, {});
    const summary: RunSummary = loadRunSummary(dir);
    expect(summary.conditions['mind-v10']!.a1).toBeNull();
    expect(summary.diffs.a1).toEqual([]);
    expect(summary.activeConditions).toEqual([]);
    expect(summary.missingStages).toEqual(['a1', 'a2', 'b']);
  });

  test('treats a malformed results file as missing instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-agg-bad-'));
    writeFixtureRun(dir, { a1: { 'mind-v9': makeA1({ hitAt5: 0 }) } });
    writeFileSync(join(dir, 'results', 'mind-v10-a1.json'), '{ this is not valid json', 'utf8');
    const summary = loadRunSummary(dir);
    // The valid condition is still read; the malformed one degrades to "missing".
    expect(summary.conditions['mind-v9']!.a1).not.toBeNull();
    expect(summary.conditions['mind-v10']!.a1).toBeNull();
    expect(summary.missingStages).not.toContain('a1');
  });
});

describe('A1 bucket passthrough', () => {
  test('keeps null metrics as null (never zero)', () => {
    const summary = aggregateA1(makeA1({ hitAt5: null }));
    expect(summary.cat1To4.hitAt5).toBeNull();
  });
});

// ── Active conditions (00014) ────────────────────────────────────────────────
//
// A summary must derive its active conditions from the artifacts that actually
// exist, never from the conditions a run merely selected. The legacy v9↔v10
// fields stay populated for historical runs; a run that measured only
// `mind-current` must not invent a historical baseline.

describe('active-condition aggregation', () => {
  const currentOnlyInput = {
    runId: 'run-current-only',
    meta: makeMeta(),
    a1: {
      'mind-current': makeA1({
        hitAt5: 0.75,
        hitAt10: 0.8,
        evidenceRecallAt10: 0.7,
        mrr: 0.6,
        precisionAt10: 0.4,
        contextTokensAt25: 500,
      }),
    },
    a2: {
      'mind-current': [makeA2('mind-current', 'q1', 'correct', { judgeScore: 0.9, f1: 0.8 })],
    },
    b: { 'mind-current': [makeScenario('mind-current', 'b1', true, { memoryCalls: 2 })] },
    missing: [],
  };

  function section(table: string, from: string, to: string | null): string {
    const start = table.indexOf(from);
    const end = to === null ? table.length : table.indexOf(to);
    return table.slice(start, end);
  }

  test('derives current-only active conditions from artifacts', () => {
    const summary = buildSummary(currentOnlyInput);
    expect(summary.activeConditions).toEqual(['mind-current']);
    // The legacy record shape still carries every canonical condition as null.
    expect(summary.conditions['mind-v9']!.a1).toBeNull();
    expect(summary.conditions['mind-v10']!.a2).toBeNull();
    expect(summary.conditions['no-memory']!.b).toBeNull();
  });

  test('renders current in the A1, A2 and B tables without historical rows', () => {
    const table = renderSummaryTable(buildSummary(currentOnlyInput));
    const a1 = section(table, '### A1', '### A2');
    const a2 = section(table, '### A2', '### B');
    const b = section(table, '### B', null);

    expect(a1).toContain('| mind-current |');
    expect(a1).not.toContain('mind-v9');
    expect(a1).not.toContain('mind-v10');

    expect(a2).toContain('| mind-current |');
    expect(a2).not.toContain('no-memory');
    expect(a2).not.toContain('mind-v9');

    expect(b).toContain('| mind-current |');
    expect(b).not.toContain('no-memory');
    expect(b).not.toContain('mind-v10');
  });

  test('invents no historical baseline or comparison for a current-only run', () => {
    const summary = buildSummary(currentOnlyInput);
    expect(summary.diffs.mindVsNoMemory).toEqual([]);
    expect(summary.diffs.pairwise).toEqual([]);
    // Baseline-delta rows may carry the measured current value, but never an
    // invented baseline and never a historical condition.
    expect(summary.diffs.a2Baseline.length).toBeGreaterThan(0);
    for (const row of summary.diffs.a2Baseline) {
      expect(row.condition).toBe('mind-current');
      expect(row.baseline).toBeNull();
      expect(row.absolute).toBeNull();
      expect(row.relative).toBeNull();
    }
    expect(summary.diffs.mindVsNoMemoryByCondition.length).toBeGreaterThan(0);
    for (const row of summary.diffs.mindVsNoMemoryByCondition) {
      expect(row.baseline).toBeNull();
      expect(Object.keys(row.conditions)).toEqual(['mind-current']);
    }
  });

  test('measures current-vs-baseline deltas for a no-memory+current run', () => {
    const summary = buildSummary({
      runId: 'run-baseline-current',
      meta: makeMeta(),
      a1: {},
      a2: {
        'no-memory': [
          makeA2('no-memory', 'q1', 'incorrect', { judgeScore: 0.1, f1: 0.3, memoryCalls: 0 }),
        ],
        'mind-current': [
          makeA2('mind-current', 'q1', 'correct', { judgeScore: 0.9, f1: 0.8, memoryCalls: 2 }),
        ],
      },
      b: {
        'no-memory': [makeScenario('no-memory', 'b1', false)],
        'mind-current': [makeScenario('mind-current', 'b1', true, { memoryCalls: 2 })],
      },
      missing: [],
    });

    expect(summary.activeConditions).toEqual(['no-memory', 'mind-current']);
    const judge = summary.diffs.a2Baseline.find(
      row =>
        row.condition === 'mind-current' &&
        row.scope === 'overall' &&
        row.metric === 'judgeScoreMean'
    )!;
    expect(judge.baseline).toBeCloseTo(0.1, 10);
    expect(judge.value).toBeCloseTo(0.9, 10);
    expect(judge.absolute).toBeCloseTo(0.8, 10);
    expect(judge.relative).toBeCloseTo(8, 10);

    // Baseline deltas only cover the measured Mind condition.
    expect(summary.diffs.a2Baseline.every(row => row.condition === 'mind-current')).toBe(true);

    const comparison = summary.diffs.mindVsNoMemoryByCondition.find(
      row => row.metric === 'a2.judgeScoreMean'
    )!;
    expect(comparison.baseline).toBeCloseTo(0.1, 10);
    expect(comparison.conditions['mind-current']).toBeCloseTo(0.9, 10);
    expect(comparison.conditions['mind-v9']).toBeUndefined();
    expect(comparison.conditions['mind-v10']).toBeUndefined();
  });

  test('compares every measured Mind condition in deterministic canonical order', () => {
    const input = {
      runId: 'run-three-mind',
      meta: makeMeta(),
      a1: {
        'mind-v9': makeA1({ hitAt5: 0 }),
        'mind-v10': makeA1({ hitAt5: 0.5 }),
        'mind-current': makeA1({ hitAt5: 0.75 }),
      },
      a2: {
        'no-memory': [makeA2('no-memory', 'q1', 'incorrect', { judgeScore: 0.1 })],
        'mind-v9': [makeA2('mind-v9', 'q1', 'partial', { judgeScore: 0.5 })],
        'mind-v10': [makeA2('mind-v10', 'q1', 'correct', { judgeScore: 0.9 })],
        'mind-current': [makeA2('mind-current', 'q1', 'correct', { judgeScore: 0.95 })],
      },
      b: {
        'no-memory': [makeScenario('no-memory', 'b1', false)],
        'mind-v9': [makeScenario('mind-v9', 'b1', true)],
        'mind-v10': [makeScenario('mind-v10', 'b1', true)],
        'mind-current': [makeScenario('mind-current', 'b1', true)],
      },
      missing: [],
    };
    const summary = buildSummary(input);

    expect(summary.activeConditions).toEqual(['no-memory', 'mind-v9', 'mind-v10', 'mind-current']);

    const a1Pairs = summary.diffs.pairwise.filter(
      pair => pair.stage === 'a1' && pair.metric === 'hitAt5'
    );
    expect(a1Pairs.map(pair => `${pair.from}->${pair.to}`)).toEqual([
      'mind-v9->mind-v10',
      'mind-v9->mind-current',
      'mind-v10->mind-current',
    ]);
    expect(a1Pairs[0]).toMatchObject({ fromValue: 0, toValue: 0.5, absolute: 0.5, relative: null });
    expect(a1Pairs[1]).toMatchObject({ fromValue: 0, toValue: 0.75, absolute: 0.75 });
    expect(a1Pairs[2]!.absolute).toBeCloseTo(0.25, 10);
    expect(a1Pairs[2]!.relative).toBeCloseTo(0.5, 10);

    // The legacy v9↔v10 comparison is retained untouched.
    const legacy = summary.diffs.a1.find(row => row.metric === 'hitAt5')!;
    expect(legacy.v9).toBe(0);
    expect(legacy.v10).toBe(0.5);

    // A2 and B get deterministic pairwise rows as well, never against the baseline.
    expect(summary.diffs.pairwise.some(pair => pair.stage === 'a2')).toBe(true);
    expect(summary.diffs.pairwise.some(pair => pair.stage === 'b')).toBe(true);
    expect(
      summary.diffs.pairwise.every(pair => pair.from !== 'no-memory' && pair.to !== 'no-memory')
    ).toBe(true);
    expect(buildSummary(input).diffs.pairwise).toEqual(summary.diffs.pairwise);
  });

  test('keeps the legacy v9/v10/no-memory output unchanged', () => {
    const legacyInput = {
      runId: 'run-legacy',
      meta: makeMeta(),
      a1: {
        'mind-v9': makeA1({ hitAt5: 0, mrr: 0 }),
        'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.5 }),
      },
      a2: {
        'no-memory': [makeA2('no-memory', 'q1', 'incorrect', { judgeScore: 0.1 })],
        'mind-v9': [makeA2('mind-v9', 'q1', 'partial', { judgeScore: 0.5 })],
        'mind-v10': [makeA2('mind-v10', 'q1', 'correct', { judgeScore: 0.9 })],
      },
      b: {},
      missing: ['a1:no-memory', 'b'],
    };
    const summary = buildSummary(legacyInput);
    expect(summary.activeConditions).toEqual(['no-memory', 'mind-v9', 'mind-v10']);

    const table = renderSummaryTable(summary);
    const a1 = section(table, '### A1', '### A2');
    const a2 = section(table, '### A2', '### B');
    expect(a1).toContain('| mind-v9 |');
    expect(a1).toContain('| mind-v10 |');
    expect(a1).not.toContain('mind-current');
    expect(a2).toContain('| no-memory |');
    expect(a2).toContain('| mind-v9 |');
    expect(a2).toContain('| mind-v10 |');
    expect(a2).not.toContain('mind-current');

    // Legacy baseline deltas stay v9/v10-only and in the same order.
    expect(new Set(summary.diffs.a2Baseline.map(row => row.condition))).toEqual(
      new Set(['mind-v9', 'mind-v10'])
    );
    // Legacy pairwise data is exactly the v9→v10 comparison.
    const a1Pairs = summary.diffs.pairwise.filter(
      pair => pair.stage === 'a1' && pair.metric === 'hitAt5'
    );
    expect(a1Pairs.map(pair => `${pair.from}->${pair.to}`)).toEqual(['mind-v9->mind-v10']);
    expect(summary.diffs.mindVsNoMemory.length).toBeGreaterThan(0);
  });
});
