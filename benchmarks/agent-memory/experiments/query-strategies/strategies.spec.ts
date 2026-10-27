// Experiment A — query-strategy unit contract.
//
// Pins the Gherkin scenario "Query strategies are deterministic and respect
// explicit operators": generation is deterministic, explicit query syntax is
// preserved verbatim, and the strategies are pure functions of (question,
// participants) — gold evidence is never an input.

import { describe, expect, test } from 'bun:test';

import {
  applyAllStrategies,
  applyStrategy,
  contentWords,
  entityTokens,
  hasExplicitSyntax,
  STRATEGIES,
  type StrategyContext,
} from './strategies';

const ctx: StrategyContext = { participants: ['Melanie', 'Caroline'] };
const QUESTIONS = [
  'What does Melanie do to keep herself busy during her pottery break?',
  'What transgender-specific events has Caroline attended?',
  'When did Melanie go to the pottery workshop?',
  'Would Melanie be considered an ally to the transgender community?',
  'What book did Caroline read in 2019?',
];

describe('determinism', () => {
  test('every strategy generates identical output on two runs', () => {
    for (const question of QUESTIONS) {
      const first = applyAllStrategies(question, ctx);
      const second = applyAllStrategies(question, ctx);
      expect(second).toEqual(first);
    }
  });

  test('applyStrategy is a pure function of (question, participants)', () => {
    for (const question of QUESTIONS) {
      for (const strategy of STRATEGIES) {
        expect(applyStrategy(strategy.id, question, ctx)).toEqual(
          applyStrategy(strategy.id, question, { participants: ['Melanie', 'Caroline'] })
        );
      }
    }
  });
});

describe('explicit query syntax is preserved', () => {
  const cases = [
    'Melanie AND pottery',
    'pottery OR painting',
    'Melanie NOT Caroline',
    'the "pottery break" moment',
    'pott* workshop',
  ];
  test('each explicit form short-circuits to the original', () => {
    for (const question of cases) {
      expect(hasExplicitSyntax(question)).toBe(true);
      for (const strategy of STRATEGIES) {
        const result = applyStrategy(strategy.id, question, ctx);
        expect(result.queries).toEqual([question]);
        expect(result.rewritten).toBe(false);
        expect(result.reason).toBe('explicit_operator_preserved');
      }
    }
  });

  test('lowercase natural-language or/and are not treated as operators', () => {
    expect(hasExplicitSyntax('Do you prefer tea or coffee?')).toBe(false);
  });
});

describe('content words (S2)', () => {
  test('function words dropped from a representative question', () => {
    const kept = contentWords(
      'What does Melanie do to keep herself busy during her pottery break?'
    );
    expect(kept).not.toContain('does');
    expect(kept).not.toContain('during');
    expect(kept).toContain('Melanie');
    expect(kept).toContain('pottery');
  });
});

describe('entity extraction (S3)', () => {
  test('extracts participant names from the context, not a hardcoded list', () => {
    // A lowercase participant mention is recovered only because the name is in
    // the (data-derived) participant set...
    expect(entityTokens('what events has caroline attended?', ctx)).toEqual(['caroline']);
    // ...and is not invented when no participants are supplied.
    expect(entityTokens('what events has caroline attended?', { participants: [] })).toEqual([]);
  });

  test('extracts non-sentence-initial capitals and numbers', () => {
    expect(entityTokens('When did Melanie visit Rome in 2019?', ctx)).toEqual([
      'Melanie',
      'Rome',
      '2019?',
    ]);
  });
});

describe('strategy shape', () => {
  test('every strategy emits 1..2 non-empty queries', () => {
    for (const question of QUESTIONS) {
      for (const result of applyAllStrategies(question, ctx)) {
        expect(result.queries.length).toBeGreaterThanOrEqual(1);
        expect(result.queries.length).toBeLessThanOrEqual(2);
        for (const query of result.queries) expect(query.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('S1 is always the original question', () => {
    for (const question of QUESTIONS) {
      const s1 = applyStrategy('S1', question, ctx);
      expect(s1.queries).toEqual([question]);
      expect(s1.rewritten).toBe(false);
    }
  });
});
