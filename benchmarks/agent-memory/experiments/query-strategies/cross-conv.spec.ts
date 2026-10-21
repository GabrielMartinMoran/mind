// Experiment A cross-conversation validation — pure shaping tests (no server, no DB).

import { describe, expect, test } from 'bun:test';

import {
  computeCrossConvGains,
  crossConvVerdict,
  renderCrossConvSection,
  upsertSection,
  type CrossConvResult,
  type StrategyMetrics,
} from './run';

function metrics(overrides: Partial<StrategyMetrics> = {}): StrategyMetrics {
  return {
    probes: 123,
    evidence_count: 123,
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

const S1 = metrics({ hit_at_10: 0.5, full_evidence_at_10: 0.4 });
const S2 = metrics({ hit_at_10: 0.6, full_evidence_at_10: 0.5 });

function result(overrides: Partial<CrossConvResult> = {}): CrossConvResult {
  const strategies = {
    S1,
    S2,
    S3: metrics(),
    S4: metrics(),
    S5: metrics(),
    S6: metrics(),
  };
  return {
    conversation: 'conv-44',
    space: 'locomo/membench',
    turns: 400,
    answerable_questions: 123,
    strategies,
    s1_vs_s2: computeCrossConvGains(S1, S2),
    ...overrides,
  };
}

describe('computeCrossConvGains', () => {
  test('uses each metric against its own baseline', () => {
    const gains = computeCrossConvGains(S1, S2);
    expect(gains.hit_gain_pp).toBeCloseTo(10, 10);
    expect(gains.full_gain_pp).toBeCloseTo(10, 10);
  });

  test('keeps full and hit gains distinct', () => {
    const gains = computeCrossConvGains(
      metrics({ hit_at_10: 0.567, full_evidence_at_10: 0.456 }),
      metrics({ hit_at_10: 0.6, full_evidence_at_10: 0.5 })
    );
    expect(gains.hit_gain_pp).toBeCloseTo(3.3, 1);
    expect(gains.full_gain_pp).toBeCloseTo(4.4, 1);
  });

  test('null metrics yield null gains', () => {
    const gains = computeCrossConvGains(
      metrics({ hit_at_10: null, full_evidence_at_10: null }),
      S2
    );
    expect(gains.hit_gain_pp).toBeNull();
    expect(gains.full_gain_pp).toBeNull();
  });
});

describe('crossConvVerdict', () => {
  test('both metrics improving replicates with a small effect', () => {
    expect(crossConvVerdict(result()).verdict).toBe('replica (efecto pequeño)');
  });

  test('both metrics unchanged does not replicate', () => {
    const c = result({
      s1_vs_s2: { full_gain_pp: 0, hit_gain_pp: 0 },
    });
    expect(crossConvVerdict(c).verdict).toBe('no se replica');
  });

  test('mixed signs are inconclusive', () => {
    const c = result({ s1_vs_s2: { full_gain_pp: 2, hit_gain_pp: -1 } });
    expect(crossConvVerdict(c).verdict).toBe('inconcluso');
  });
});

describe('renderCrossConvSection', () => {
  test('renders §11 with the conversation, both deltas and the robustness trade-off', () => {
    const section = renderCrossConvSection(result());
    expect(section).toContain('## 11. Validación cruzada — `conv-44`');
    expect(section).toContain('| S2 |');
    expect(section).toContain('full@10 +10.0pp');
    expect(section).toContain('hit@10 +10.0pp');
    expect(section).toContain('Trade-off de robustez');
    expect(section).toContain('Veredicto de replicación: replica (efecto pequeño)');
  });
});

describe('upsertSection', () => {
  test('appends a section when none exists', () => {
    expect(upsertSection('# report', '## 11. x')).toContain('## 11. x');
  });

  test('replaces an existing §11 instead of duplicating it', () => {
    const once = upsertSection('# report\n\n## 11. old\n', '## 11. new');
    const twice = upsertSection(once, '## 11. new');
    expect(twice.match(/## 11\./g)?.length).toBe(1);
    expect(twice).not.toContain('old');
    expect(twice).toContain('## 11. new');
  });
});
