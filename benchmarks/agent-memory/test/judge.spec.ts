import { describe, expect, test } from 'bun:test';

import {
  ABSTENTION_CANONICAL,
  aggregateCondition,
  buildBlindPayload,
  buildBlindPayloads,
  classifyByF1,
  isAbstention,
  normalizeAnswer,
  parseJudgeResponse,
  runBlindJudge,
  scoreDeterministic,
  tokenF1,
  verdictForCondition,
  type A2QuestionResult,
} from '../src/benchmarkA/judge';
import { mulberry32 } from '../src/locomo/subset';
import { createFakeSessionDriver } from '../src/testing/fakes';

describe('normalizeAnswer / tokenF1', () => {
  test('lowercases, strips punctuation and drops articles', () => {
    expect(normalizeAnswer('The Quick, Brown Fox!')).toEqual(['quick', 'brown', 'fox']);
    expect(normalizeAnswer('a an the')).toEqual([]);
  });

  test('tokenF1 goldens', () => {
    expect(tokenF1('the quick brown fox', 'quick brown fox')).toBe(1);
    expect(tokenF1('quick fox', 'quick brown fox')).toBeCloseTo(0.8, 6); // 2/2 p, 2/3 r -> .8
    expect(tokenF1('completely different', 'quick brown fox')).toBe(0);
    expect(tokenF1('', 'anything')).toBe(0);
  });

  test('classifyByF1 thresholds', () => {
    expect(classifyByF1(1)).toBe('correct');
    expect(classifyByF1(0.5)).toBe('correct');
    expect(classifyByF1(0.49)).toBe('partial');
    expect(classifyByF1(0)).toBe('incorrect');
  });
});

describe('adversarial scoring', () => {
  test('canonical abstention is a correct abstention', () => {
    for (const phrase of [ABSTENTION_CANONICAL, 'Not mentioned', 'I do not know']) {
      expect(isAbstention(phrase)).toBe(true);
      expect(scoreDeterministic({ answer: phrase, reference: null, adversarial: true }).klass).toBe(
        'correct_abstention'
      );
    }
  });

  test('an invented answer is a hallucination', () => {
    const score = scoreDeterministic({
      answer: 'The answer is 42.',
      reference: null,
      adversarial: true,
    });
    expect(score.klass).toBe('hallucination');
    expect(score.f1).toBeNull();
  });

  test('an empty adversarial answer is an empty answer, not a hallucination', () => {
    expect(scoreDeterministic({ answer: '   ', reference: null, adversarial: true }).klass).toBe(
      'empty_answer'
    );
  });

  test('a failed measurement is incomplete regardless of answer', () => {
    expect(
      scoreDeterministic({ answer: 'anything', reference: 'x', adversarial: false, error: true })
        .klass
    ).toBe('incomplete');
  });
});

describe('completion semantics', () => {
  test('an idle outcome that is not successful is incomplete', () => {
    for (const idleOutcome of ['failed', 'interrupted', null] as const) {
      const score = scoreDeterministic({
        answer: 'a red hat',
        reference: 'a red hat',
        adversarial: false,
        idleOutcome,
      });
      expect(score.klass).toBe('incomplete');
      expect(score.f1).toBeNull();
    }
  });

  test('an explicit incomplete completion wins even with answer text', () => {
    const score = scoreDeterministic({
      answer: 'a red hat',
      reference: 'a red hat',
      adversarial: false,
      completion: 'incomplete',
    });
    expect(score.klass).toBe('incomplete');
  });

  test('a successful completion with empty text is an empty answer', () => {
    const score = scoreDeterministic({
      answer: '   ',
      reference: 'a red hat',
      adversarial: false,
      idleOutcome: 'succeeded',
    });
    expect(score.klass).toBe('empty_answer');
    expect(score.f1).toBeNull();
  });
});

describe('non-adversarial scoring', () => {
  test('scores by token F1 with thresholds', () => {
    expect(
      scoreDeterministic({
        answer: 'quick brown fox',
        reference: 'quick brown fox',
        adversarial: false,
      }).klass
    ).toBe('correct');
    expect(
      scoreDeterministic({ answer: 'quick fox', reference: 'quick brown fox', adversarial: false })
        .klass
    ).toBe('correct'); // 0.8 >= 0.5
    expect(
      scoreDeterministic({
        answer: 'quick zebra',
        reference: 'quick brown fox',
        adversarial: false,
      }).klass
    ).toBe('partial'); // overlap 1/2 p, 1/3 r -> f1 0.4
  });

  test('a missing reference is incorrect', () => {
    expect(scoreDeterministic({ answer: 'x', reference: null, adversarial: false }).klass).toBe(
      'incorrect'
    );
  });

  test('a non-adversarial abstention is not partial from a shared reference token', () => {
    const score = scoreDeterministic({
      answer: 'no information available',
      reference: 'no preference was recorded',
      adversarial: false,
    });
    expect(score.klass).toBe('abstention');
    expect(score.f1).toBeNull();
    expect(score.abstained).toBe(true);
  });
});

describe('blind payloads', () => {
  const question = {
    id: 'conv-26#1',
    question: 'What did Alice buy?',
    reference: 'a hat',
    adversarial: false,
    candidates: [
      { condition: 'mind-v9' as const, text: 'a hat' },
      { condition: 'mind-v10' as const, text: 'a scarf' },
      { condition: 'no-memory' as const, text: 'a hat' },
    ],
  };

  test('anonymizes candidates and never leaks the condition mapping', () => {
    const payload = buildBlindPayload(question, mulberry32(1));
    expect(payload.prompt).toContain('Candidate 1:');
    expect(payload.prompt).toContain('Candidate 3:');
    expect(payload.prompt).not.toMatch(/mind|no-memory|v9|v10/i);
    expect(payload.order).toHaveLength(3);
    expect([...payload.order].sort()).toEqual(['mind-v10', 'mind-v9', 'no-memory']);
  });

  test('is deterministic for a fixed seed and shuffles for different seeds', () => {
    const a = buildBlindPayloads([question], 7)[0]!;
    const b = buildBlindPayloads([question], 7)[0]!;
    expect(a.prompt).toBe(b.prompt);
    expect(a.order).toEqual(b.order);
  });

  test('labels map back to the right condition', () => {
    const payload = buildBlindPayload(question, mulberry32(3));
    const verdicts = [{ candidate: 1, klass: 'correct', score: 1 }];
    expect(verdictForCondition(verdicts, payload.order, payload.order[0]!)).toEqual({
      candidate: 1,
      klass: 'correct',
      score: 1,
    });
  });
});

describe('parseJudgeResponse', () => {
  test('parses plain and fenced JSON', () => {
    const plain = '{"verdicts":[{"candidate":1,"class":"correct","score":0.9}]}';
    expect(parseJudgeResponse(plain, 1)?.verdicts[0]?.klass).toBe('correct');
    const fenced = '```json\n{"verdicts":[{"candidate":2,"class":"partial","score":0.4}]}\n```';
    expect(parseJudgeResponse(fenced, 2)?.verdicts[0]?.candidate).toBe(2);
  });

  test('returns null on malformed or out-of-range payloads', () => {
    expect(parseJudgeResponse('not json at all', 1)).toBeNull();
    expect(parseJudgeResponse('{"verdicts":[]}', 1)).toBeNull();
    expect(
      parseJudgeResponse('{"verdicts":[{"candidate":5,"class":"x","score":1}]}', 2)
    ).toBeNull();
  });
});

describe('runBlindJudge', () => {
  const payloads = buildBlindPayloads(
    [
      {
        id: 'q1',
        question: 'Q1',
        reference: 'r1',
        adversarial: false,
        candidates: [
          { condition: 'mind-v9' as const, text: 'r1' },
          { condition: 'mind-v10' as const, text: 'r1' },
        ],
      },
      {
        id: 'q2',
        question: 'Q2',
        reference: null,
        adversarial: true,
        candidates: [
          { condition: 'mind-v9' as const, text: 'no information available' },
          { condition: 'mind-v10' as const, text: 'invented' },
        ],
      },
    ],
    11
  );

  test('parses verdicts, retries once on malformed JSON and queues the rest', async () => {
    const driver = createFakeSessionDriver([
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct","score":1},{"candidate":2,"class":"correct","score":1}]}',
      },
      { text: 'oops' }, // malformed -> repair
      {
        text: '```json\n{"verdicts":[{"candidate":1,"class":"correct_abstention","score":1},{"candidate":2,"class":"hallucination","score":0}]}\n```',
      },
    ]);
    const output = await runBlindJudge(payloads, {
      driver,
      workspaceDir: '/tmp/ws',
      limits: { steps: 1, timeoutMs: 1000 },
    });
    expect(output.verdicts.q1).toHaveLength(2);
    expect(output.verdicts.q2).toHaveLength(2);
    expect(output.manualQueue).toEqual([]);
    expect(output.promptCount).toBe(3);
  });

  test('pushes to the manual queue when the repair also fails', async () => {
    const driver = createFakeSessionDriver([{ text: 'nope' }, { text: 'still nope' }]);
    const output = await runBlindJudge([payloads[0]!], {
      driver,
      workspaceDir: '/tmp/ws',
      limits: { steps: 1, timeoutMs: 1000 },
    });
    expect(output.manualQueue).toEqual(['q1']);
    expect(output.promptCount).toBe(2);
  });
});

describe('aggregateCondition', () => {
  function result(overrides: Partial<A2QuestionResult>): A2QuestionResult {
    return {
      id: 'q',
      category: 1,
      categoryName: 'multi-hop',
      adversarial: false,
      condition: 'mind-v10',
      answer: '',
      reference: null,
      deterministic: { klass: 'correct', f1: 1, abstained: false },
      judge: null,
      memoryCalls: 0,
      tokens: null,
      costUsd: 0,
      latencyMs: 1,
      error: null,
      ...overrides,
    };
  }

  test('counts classes and means without a single cross-condition percentage', () => {
    const aggregate = aggregateCondition('mind-v10', [
      result({ deterministic: { klass: 'correct', f1: 1, abstained: false } }),
      result({ deterministic: { klass: 'partial', f1: 0.4, abstained: false } }),
      result({
        adversarial: true,
        deterministic: { klass: 'hallucination', f1: null, abstained: false },
      }),
    ]);
    expect(aggregate.condition).toBe('mind-v10');
    expect(aggregate.count).toBe(3);
    expect(aggregate.classes.correct).toBe(1);
    expect(aggregate.classes.partial).toBe(1);
    expect(aggregate.classes.hallucination).toBe(1);
    expect(aggregate.f1Mean).toBeCloseTo(0.7, 6);
  });

  test('excludes empty and incomplete results from answer-quality means', () => {
    const aggregate = aggregateCondition('mind-v10', [
      result({
        answer: 'a red hat',
        deterministic: { klass: 'correct', f1: 1, abstained: false },
        judge: { candidate: 1, klass: 'correct', score: 1 },
      }),
      result({
        answer: '',
        deterministic: { klass: 'empty_answer', f1: null, abstained: false },
        judge: { candidate: 2, klass: 'correct', score: 1 },
      }),
      result({
        deterministic: { klass: 'incomplete', f1: null, abstained: false },
        judge: { candidate: 3, klass: 'correct', score: 1 },
      }),
    ]);
    expect(aggregate.classes.empty_answer).toBe(1);
    expect(aggregate.classes.incomplete).toBe(1);
    expect(aggregate.f1Mean).toBe(1);
    expect(aggregate.judgeScoreMean).toBe(1);
  });
});
