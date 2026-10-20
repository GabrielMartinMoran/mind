// Experiment A runner — pure helper tests (no server, no DB).

import { describe, expect, test } from 'bun:test';

import type { ReplayChunk } from '../replay/replay';

import {
  buildAnalysis,
  computeMetrics,
  unionChunks,
  type ResultsFile,
  type StrategyExecution,
  type StrategyMetrics,
} from './run';

function chunk(name: string, content = `c-${name}`): ReplayChunk {
  return { name, score: 1, confidence: 'high', methods: ['any'], content };
}

describe('unionChunks', () => {
  test('concatenates in query order and dedupes by name', () => {
    const out = unionChunks(
      [
        [chunk('A'), chunk('B')],
        [chunk('B'), chunk('C')],
      ],
      10
    );
    expect(out.map(c => c.name)).toEqual(['A', 'B', 'C']);
  });

  test('caps at the limit', () => {
    const out = unionChunks([[chunk('A'), chunk('B'), chunk('C')]], 2);
    expect(out.map(c => c.name)).toEqual(['A', 'B']);
  });
});

function exec(refs: string[], contents: string[] = refs.map(name => name)): StrategyExecution {
  return {
    queries: ['q'],
    rewritten: false,
    reason: 'original',
    ranked_refs: refs,
    ranked_contents: contents,
    result_count: refs.length,
    latency_ms: 1,
  };
}

describe('computeMetrics', () => {
  test('hit@10 (any) and full@10 (all) are distinct', () => {
    const m = computeMetrics(
      [exec(['X', 'A']), exec(['A', 'B'])],
      [
        ['A', 'B'],
        ['A', 'B'],
      ]
    );
    expect(m.hit_at_10).toBe(1);
    expect(m.full_evidence_at_10).toBe(0.5);
  });

  test('probes without evidence are excluded from evidence metrics', () => {
    const m = computeMetrics([exec(['A']), exec(['Z'])], [['A'], []]);
    expect(m.probes).toBe(2);
    expect(m.evidence_count).toBe(1);
    expect(m.hit_at_10).toBe(1);
  });
});

function metrics(overrides: Partial<StrategyMetrics> = {}): StrategyMetrics {
  return {
    probes: 92,
    evidence_count: 90,
    hit_at_10: 0,
    full_evidence_at_10: 0,
    evidence_recall_at_10: 0,
    mrr: 0,
    precision_at_10: 0,
    context_tokens_at_10: 0,
    mean_results: 0,
    zero_result_count: 0,
    latency_p50_ms: 0,
    ...overrides,
  };
}

function resultsWith(s1: StrategyMetrics, s2: StrategyMetrics): ResultsFile {
  const ids = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
  return {
    meta: {},
    baseline: {
      frozen: { ALL: 41, partial: 10, NONE: 39, no_evidence_gold: 2 },
      s1_funnel: {},
      funnel_match: true,
      admitted_top10: 65,
      admitted_top10_match: true,
      dump_ranking_match: null,
    },
    determinism: { compared: 0, identical: true },
    strategies: ids.map(id => ({
      id,
      label: id,
      description: id,
      rewritten_count: 0,
      mean_queries: 1,
      overall_answerable: id === 'S1' ? s1 : id === 'S2' ? s2 : metrics(),
      by_category: {},
      adversarial: {
        probes: 0,
        mean_results: 0,
        zero_result_count: 0,
        evidence_recall_at_10: null,
      },
    })),
    secondary: { limit: 25, strategies: [] },
    per_probe: [],
  };
}

describe('buildAnalysis deltas', () => {
  test('hit@10 and full@10 deltas each use their own baseline', () => {
    // Real conv-26 values: S1 hit .567 / full .456; S2 hit .600 / full .500.
    const analysis = buildAnalysis(
      resultsWith(
        metrics({ hit_at_10: 0.5666666667, full_evidence_at_10: 0.4555555556 }),
        metrics({ hit_at_10: 0.6, full_evidence_at_10: 0.5 })
      )
    );
    const rationale = analysis.recommendations.S2!.rationale;
    expect(rationale).toContain('hit@10 +3.3pp');
    expect(rationale).toContain('full@10 +4.4pp');
    expect(rationale).not.toContain('+14.4pp');
  });

  test('deltas diverge and can have opposite signs', () => {
    const analysis = buildAnalysis(
      resultsWith(
        metrics({ hit_at_10: 0.6, full_evidence_at_10: 0.4 }),
        metrics({ hit_at_10: 0.5, full_evidence_at_10: 0.5 })
      )
    );
    const rationale = analysis.recommendations.S2!.rationale;
    expect(rationale).toContain('hit@10 -10.0pp');
    expect(rationale).toContain('full@10 +10.0pp');
  });

  test('missing baseline metrics render as n/a', () => {
    const analysis = buildAnalysis(
      resultsWith(
        metrics({ hit_at_10: null, full_evidence_at_10: null }),
        metrics({ hit_at_10: 0.5, full_evidence_at_10: 0.5 })
      )
    );
    expect(analysis.recommendations.S2!.rationale).toContain('hit@10 n/a');
    expect(analysis.recommendations.S2!.rationale).toContain('full@10 n/a');
  });
});
