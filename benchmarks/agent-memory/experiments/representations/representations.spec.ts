// Experiment B — pure transform, name-mapping and evidence-matching tests.
//
// No DB, no server, no clock: every helper under test is deterministic.

import { describe, expect, test } from 'bun:test';

import type { TurnRecord } from '../../src/locomo/ingest';

import {
  buildSessionMemories,
  buildTurnMemories,
  compareTop10,
  descriptiveName,
  diaFromTags,
  diaIdsInContent,
  evaluateProbe,
  evidenceIdsFor,
  matchEvidence,
  metricDelta,
  normalizeDia,
  otherSpeaker,
  slugToken,
  summarizeFunnel,
  summarizeItemLabels,
  summarizeMetrics,
  type MetricsSummary,
  type RetrievedMemory,
} from './representations';
import { buildGateReport, withoutPhotoCaptions, type CapturedProbe } from './run';

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const diaId = overrides.diaId ?? 'D17:10';
  return {
    diaId,
    session: 17,
    speaker: 'Melanie',
    text: 'I read a book and painted.',
    sessionDateTime: '1:56 pm on 20 May, 2023',
    content: `[1:56 pm on 20 May, 2023] Melanie: I read a book and painted.`,
    tags: ['locomo', 'session:17'],
    ...overrides,
  };
}

function memory(name: string, content = name, tags: readonly string[] = []): RetrievedMemory {
  return { name, content, tags };
}

describe('slugToken / otherSpeaker', () => {
  test('lowercases and collapses non-alphanumerics', () => {
    expect(slugToken('Melanie')).toBe('melanie');
    expect(slugToken('Ana María')).toBe('ana-maria');
    expect(slugToken('--')).toBe('unknown');
  });

  test('returns the other participant case-insensitively', () => {
    expect(otherSpeaker(turn(), ['Caroline', 'Melanie'])).toBe('Caroline');
    expect(otherSpeaker(turn({ speaker: 'Caroline' }), ['Caroline', 'Melanie'])).toBe('Melanie');
  });

  test('returns undefined when participants are unknown or ambiguous', () => {
    expect(otherSpeaker(turn(), [])).toBeUndefined();
    expect(otherSpeaker(turn(), ['Melanie'])).toBeUndefined();
  });
});

describe('descriptiveName', () => {
  test('preserves provenance and adds non-invented searchable tokens', () => {
    expect(descriptiveName(turn(), 'Caroline')).toBe('s17-d17-melanie-caroline-10');
  });

  test('omits the other-participant segment when it is not determinable', () => {
    expect(descriptiveName(turn(), undefined)).toBe('s17-d17-melanie-10');
  });

  test('is deterministic and unique per turn', () => {
    const a = descriptiveName(turn({ diaId: 'D1:1', session: 1 }), 'Caroline');
    const b = descriptiveName(turn({ diaId: 'D1:2', session: 1 }), 'Caroline');
    expect(a).not.toBe(b);
    expect(a).toBe(descriptiveName(turn({ diaId: 'D1:1', session: 1 }), 'Caroline'));
  });
});

describe('buildTurnMemories', () => {
  const participants = ['Caroline', 'Melanie'];

  test('V1 keeps the current benchmark shape byte-identical', () => {
    const source = turn();
    const [draft] = buildTurnMemories([source], 'V1', participants);
    expect(draft!.name).toBe('D17:10');
    expect(draft!.content).toBe(source.content);
    expect(draft!.tags).toEqual(['locomo', 'session:17']);
  });

  test('V2 keeps content identical and enriches tags with provenance', () => {
    const source = turn();
    const [draft] = buildTurnMemories([source], 'V2', participants);
    expect(draft!.content).toBe(source.content);
    expect(draft!.name).toBe('s17-d17-melanie-caroline-10');
    expect(draft!.tags).toEqual(['locomo', 'session:17', 'speaker:melanie', 'dia:d17:10']);
  });

  test('V2n uses descriptive names but the original tags (name-only effect)', () => {
    const [draft] = buildTurnMemories([turn()], 'V2n', participants);
    expect(draft!.name).toBe('s17-d17-melanie-caroline-10');
    expect(draft!.tags).toEqual(['locomo', 'session:17']);
  });
});

describe('buildSessionMemories (V3)', () => {
  test('groups turns by session, in order, with date header and dia prefixes', () => {
    const drafts = buildSessionMemories([
      turn({ session: 1, diaId: 'D1:1', speaker: 'Caroline', text: 'Hi' }),
      turn({
        session: 1,
        diaId: 'D1:2',
        text: 'Hey',
        blipCaption: 'a pottery class',
      }),
      turn({ session: 2, diaId: 'D2:1', speaker: 'Caroline', text: 'Later' }),
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.name).toBe('session-1');
    expect(drafts[0]!.tags).toEqual(['locomo', 'session:1']);
    expect(drafts[0]!.content).toContain('[1:56 pm on 20 May, 2023]');
    expect(drafts[0]!.content).toContain('[D1:1] Caroline: Hi');
    expect(drafts[0]!.content).toContain('[D1:2] Melanie: Hey\n[Photo: a pottery class]');
    expect(drafts[0]!.diaIds).toEqual(['D1:1', 'D1:2']);
    expect(drafts[1]!.name).toBe('session-2');
  });
});

describe('evidence mapping', () => {
  test('normalizes dia ids and reads the provenance tag, not the name', () => {
    expect(normalizeDia(' D17:10 ')).toBe('d17:10');
    expect(diaFromTags(['locomo', 'dia:D17:10'])).toBe('d17:10');
    expect(diaFromTags(['locomo', 'session:17'])).toBeUndefined();
  });

  test('V2 maps via dia tag even when the name does not contain the dia id verbatim', () => {
    const retrieved = memory('s17-d17-melanie-caroline-10', 'body', ['dia:D17:10']);
    expect([...evidenceIdsFor(retrieved, { kind: 'dia-tag' })]).toEqual(['d17:10']);
  });

  test('V2n maps through the ingestion registry', () => {
    const registry = new Map([['s17-d17-melanie-caroline-10', 'D17:10']]);
    const retrieved = memory('s17-d17-melanie-caroline-10');
    expect([...evidenceIdsFor(retrieved, { kind: 'registry', nameToDia: registry })]).toEqual([
      'd17:10',
    ]);
  });

  test('V3 extracts every [dia_id] in a session chunk', () => {
    const content = '[date]\n[D1:1] Caroline: Hi\n[D1:2] Melanie: Hey';
    expect([...diaIdsInContent(content)].sort()).toEqual(['d1:1', 'd1:2']);
  });

  test('matchEvidence reports first ranks and relevant memories', () => {
    const ranked = [memory('D1:1'), memory('D2:2'), memory('D3:3')];
    const match = matchEvidence(ranked, ['D2:2', 'D3:3'], { kind: 'dia-name' });
    expect(match.ranks.get('d3:3')).toBe(2);
    expect(match.matched).toBe(2);
    expect(match.relevantMemories).toBe(2);
  });
});

describe('evaluateProbe', () => {
  test('hit@k, full@k, recall, MRR and context tokens for turn memories', () => {
    const ranked = [memory('D1:1', 'abcd'), memory('D2:2', 'abcdefgh')];
    const evaluation = evaluateProbe(ranked, ['D2:2'], { kind: 'dia-name' }, 10);
    expect(evaluation.hitAny).toBe(true);
    expect(evaluation.fullEvidence).toBe(true);
    expect(evaluation.evidenceRecall).toBe(1);
    expect(evaluation.reciprocalRank).toBe(0.5);
    expect(evaluation.precision).toBe(0.5);
    expect(evaluation.contextTokens).toBe(3);
    expect(evaluation.matchedWithinK).toBe(1);
  });

  test('a gold item beyond k is matched but not hit', () => {
    const ranked = Array.from({ length: 11 }, (_, index) => memory(`D1:${index + 1}`));
    const evaluation = evaluateProbe(ranked, ['D1:11'], { kind: 'dia-name' }, 10);
    expect(evaluation.matched).toBe(1);
    expect(evaluation.matchedWithinK).toBe(0);
    expect(evaluation.hitAny).toBe(false);
    expect(evaluation.reciprocalRank).toBe(1 / 11);
  });

  test('V3 chunk matching counts multiple evidence items in one memory', () => {
    const chunk = memory('session-1', '[date]\n[D1:1] A: x\n[D1:2] B: y');
    const evaluation = evaluateProbe([chunk], ['D1:1', 'D1:2'], { kind: 'containment' }, 10);
    expect(evaluation.fullEvidence).toBe(true);
    expect(evaluation.precision).toBe(1);
    expect(evaluation.firstRank).toBe(0);
  });

  test('probes without gold return null evidence metrics', () => {
    const evaluation = evaluateProbe([memory('D1:1', 'abcd')], [], { kind: 'dia-name' }, 10);
    expect(evaluation.evidenceRecall).toBeNull();
    expect(evaluation.reciprocalRank).toBeNull();
    expect(evaluation.precision).toBeNull();
    expect(evaluation.contextTokens).toBe(1);
  });
});

function evaluated(
  goldCount: number,
  matchedWithinK: number,
  latency = 1
): {
  evaluation: ReturnType<typeof evaluateProbe>;
  latencyMs: number;
} {
  return {
    evaluation: {
      goldCount,
      matched: matchedWithinK,
      matchedWithinK,
      firstRank: matchedWithinK > 0 ? 0 : null,
      hitAny: matchedWithinK > 0,
      fullEvidence: goldCount > 0 && matchedWithinK === goldCount,
      evidenceRecall: goldCount === 0 ? null : matchedWithinK / goldCount,
      reciprocalRank: matchedWithinK > 0 ? 1 : 0,
      precision: goldCount === 0 ? null : matchedWithinK > 0 ? 1 : 0,
      contextTokens: 10,
      resultCount: 2,
    },
    latencyMs: latency,
  };
}

describe('V1F content calibration', () => {
  test('strips photo captions to match the frozen benchmark DB content', () => {
    const source = turn({
      diaId: 'D8:2',
      session: 8,
      text: 'text',
      sessionDateTime: 'date',
      content: '[date] Melanie: text\n[Photo: a caption]',
      blipCaption: 'a caption',
    });
    const [stripped] = withoutPhotoCaptions([source]);
    expect(stripped!.content).not.toContain('[Photo:');
    expect(stripped!.content).toContain('[date] Melanie: text');
    expect(stripped!.blipCaption).toBeUndefined();
  });

  test('buildGateReport measures the frozen funnel and item labels', () => {
    const probe = (id: string, question: string): CapturedProbe['probe'] => ({
      probe_id: id,
      question,
      category: 'single-hop',
      adversarial: false,
      context_chunks: null,
    });
    const pass: CapturedProbe[] = [
      {
        probe: probe('p1', 'q1'),
        ranked: Array.from({ length: 11 }, (_, index) => memory(`D1:${index + 1}`)),
        latencyMs: 1,
      },
      {
        probe: probe('p2', 'q2'),
        ranked: [memory('D2:1')],
        latencyMs: 1,
      },
    ];
    const gold = new Map([
      ['q1', { evidence: ['D1:1', 'D1:12'] }],
      ['q2', { evidence: ['D2:1'] }],
    ]);
    const gate = buildGateReport(
      pass,
      pass.map(entry => entry.probe),
      gold,
      null
    );
    expect(gate.funnel).toEqual({ ALL: 1, partial: 1, NONE: 0, no_evidence_gold: 0 });
    expect(gate.item_labels.admitted_top10).toBe(2);
    expect(gate.item_labels.admitted_outside_top10).toBe(0);
    expect(gate.item_labels.absent_from_ranking).toBe(1);
    expect(gate.top10_vs_dump.match).toBe(false);
  });
});

describe('summaries and gate helpers', () => {
  test('funnel separates ALL, partial, NONE and no-gold probes', () => {
    const funnel = summarizeFunnel([
      evaluated(2, 2).evaluation,
      evaluated(2, 1).evaluation,
      evaluated(1, 0).evaluation,
      evaluated(0, 0).evaluation,
    ]);
    expect(funnel).toEqual({ ALL: 1, partial: 1, NONE: 1, no_evidence_gold: 1 });
  });

  test('summarizeMetrics excludes no-gold probes from evidence metrics', () => {
    const summary: MetricsSummary = summarizeMetrics(
      [evaluated(2, 2, 2), evaluated(2, 0, 4), evaluated(0, 0, 6)],
      10
    );
    expect(summary.probes).toBe(3);
    expect(summary.evidence_count).toBe(2);
    expect(summary.hit_at_k).toBe(0.5);
    expect(summary.full_evidence_at_k).toBe(0.5);
    expect(summary.mrr).toBe(0.5);
    expect(summary.mean_results).toBe(2);
    expect(summary.latency_p50_ms).toBe(4);
  });

  test('item labels count top-10, outside and absent evidence', () => {
    const labels = summarizeItemLabels(
      [['D1:1', 'D1:2', 'D1:3'], ['D1:4']],
      [['D1:1', 'D1:5'], ['D1:4']]
    );
    // D1:1 top10, D1:5 absent, D1:4 top10
    expect(labels.admitted_top10).toBe(2);
    expect(labels.admitted_outside_top10).toBe(0);
    expect(labels.absent_from_ranking).toBe(1);
    expect(labels.total).toBe(3);
  });

  test('compareTop10 reports the first mismatch and length mismatch', () => {
    expect(compareTop10([['A', 'B']], [['A', 'B']])).toEqual({ compared: 1, mismatches: 0 });
    expect(compareTop10([['A', 'B']], [['A', 'C']])).toEqual({ compared: 1, mismatches: 1 });
    expect(compareTop10([['A']], [])).toEqual({ compared: 0, mismatches: 1 });
  });

  test('metricDelta subtracts each metric from its own baseline', () => {
    const base: MetricsSummary = {
      probes: 1,
      evidence_count: 1,
      hit_at_k: 0.5,
      full_evidence_at_k: 0.4,
      evidence_recall_at_k: 0.6,
      mrr: 0.3,
      precision_at_k: 0.1,
      context_tokens_at_k: 100,
      mean_results: 8,
      zero_result_count: 0,
      latency_p50_ms: 1,
    };
    const variant: MetricsSummary = {
      ...base,
      hit_at_k: 0.55,
      full_evidence_at_k: 0.45,
      evidence_recall_at_k: 0.65,
      mrr: 0.35,
      precision_at_k: 0.12,
      context_tokens_at_k: 90,
      mean_results: 7,
    };
    const delta = metricDelta(variant, base);
    expect(delta.hit_at_k_pp).toBeCloseTo(5);
    expect(delta.full_evidence_at_k_pp).toBeCloseTo(5);
    expect(delta.mrr_delta).toBeCloseTo(0.05);
    expect(delta.context_tokens_delta).toBe(-10);
    expect(delta.mean_results_delta).toBe(-1);
  });
});
