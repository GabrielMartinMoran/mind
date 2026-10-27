import { describe, expect, test } from 'bun:test';

import type { A1Engine } from '../src/locomo/a1';
import { runA1 } from '../src/locomo/a1';
import type { SubsetItem } from '../src/locomo/subset';

function item(
  overrides: Partial<SubsetItem> & Pick<SubsetItem, 'id' | 'question' | 'evidence'>
): SubsetItem {
  const category = overrides.category ?? 4;
  return {
    sampleId: 'conv-syn',
    questionIndex: 0,
    category,
    categoryName: 'single-hop',
    answer: 'a',
    adversarial: category === 5,
    ...overrides,
  };
}

interface FakeReply {
  readonly refs: readonly string[];
  readonly latencyMs?: number;
}

function fakeEngine(replies: Record<string, FakeReply>): {
  engine: A1Engine;
  requestedLimits: number[];
} {
  const requestedLimits: number[] = [];
  const engine: A1Engine = {
    space: 'locomo/conv-26',
    async searchRanked(query, options) {
      requestedLimits.push(options.limit);
      const reply = replies[query] ?? { refs: [] };
      return {
        rows: reply.refs.map((ref, index) => ({
          ref,
          space: 'locomo/conv-26',
          content: `content of ${ref}`,
          rankPosition: index + 1,
          nativeScoreKind: 'score' as const,
          nativeScore: 1 - index * 0.1,
        })),
        latencyMs: reply.latencyMs ?? 5,
      };
    },
  };
  return { engine, requestedLimits };
}

const items: SubsetItem[] = [
  item({ id: 's#0', question: 'q1', evidence: ['D1:1'] }),
  item({
    id: 's#1',
    question: 'q2',
    evidence: ['D1:2', 'D2:1'],
    category: 1,
    categoryName: 'multi-hop',
  }),
  item({
    id: 's#2',
    question: 'q3',
    evidence: ['D3:1'],
    category: 5,
    categoryName: 'adversarial',
    adversarial: true,
  }),
  item({ id: 's#3', question: 'q4', evidence: [], category: 3, categoryName: 'open-domain' }),
];

describe('runA1', () => {
  test('wires per-question metrics, requests top-25 and preserves array order', async () => {
    const { engine, requestedLimits } = fakeEngine({
      q1: { refs: ['D1:1', 'x', 'y'] },
      q2: { refs: ['a', 'D2:1', 'D1:2'] },
      q3: { refs: ['D3:1'] },
      q4: { refs: [] },
    });

    const result = await runA1(engine, items);
    expect(requestedLimits).toEqual([25, 25, 25, 25]);

    const q1 = result.questions[0]!;
    expect(q1.rankedRefs).toEqual(['D1:1', 'x', 'y']);
    expect(q1.metrics.hitAt5).toBe(true);
    expect(q1.metrics.hitAt10).toBe(true);
    expect(q1.metrics.mrr).toBe(1);
    expect(q1.metrics.evidenceRecallAt10).toBe(1);
    expect(q1.metrics.precisionAt10).toBeCloseTo(1 / 3, 10);

    const q2 = result.questions[1]!;
    expect(q2.metrics.hitAt5).toBe(true);
    expect(q2.metrics.mrr).toBe(0.5);
    expect(q2.metrics.evidenceRecallAt10).toBe(1);

    // Empty-evidence question: evidence metrics are N/A.
    const q4 = result.questions[3]!;
    expect(q4.evidenceEvaluable).toBe(false);
    expect(q4.metrics.mrr).toBeNull();
    expect(q4.metrics.evidenceRecallAt10).toBeNull();
    expect(q4.metrics.precisionAt10).toBeNull();
  });

  test('aggregates categories 1-4 pooled and reports cat5 separately', async () => {
    const { engine } = fakeEngine({
      q1: { refs: ['D1:1'] },
      q2: { refs: ['D1:2', 'D2:1'] },
      q3: { refs: ['D3:1', 'z'] },
      q4: { refs: [] },
    });

    const { aggregates } = await runA1(engine, items);
    // cat1-4 pooled: q1, q2, q4 (3 questions, 2 evaluable).
    expect(aggregates.overallCat1To4.count).toBe(3);
    expect(aggregates.overallCat1To4.evidenceCount).toBe(2);
    expect(aggregates.overallCat1To4.hitAt5).toBe(1);
    // cat5 is separate and its evidence is treated as a premise (still scored).
    expect(aggregates.cat5Adversarial.count).toBe(1);
    expect(aggregates.cat5Adversarial.evidenceCount).toBe(1);
    expect(aggregates.cat5Adversarial.mrr).toBe(1);
    expect(aggregates.perCategory['5']!.count).toBe(1);
    expect(aggregates.perCategory['3']!.count).toBe(1);
  });

  test('context tokens are reported at 5/10/25', async () => {
    const replies = {
      q1: { refs: ['D1:1'] },
      q2: { refs: ['D1:2'] },
      q3: { refs: ['D3:1'] },
      q4: { refs: [] },
    };
    const { engine } = fakeEngine(replies);
    const { questions } = await runA1(engine, items);
    // "content of D1:1" => 15 chars => ceil(15/4)=4 tokens.
    expect(questions[0]!.metrics.contextTokensAt5).toBe(4);
    expect(questions[0]!.metrics.contextTokensAt25).toBe(4);
  });
});
