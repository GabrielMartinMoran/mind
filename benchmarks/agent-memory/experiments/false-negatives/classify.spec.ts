// E-WB2 classifier tests (synthetic fixtures only; no DB, no network).
//
// These tests pin the stage-labelling contract from the Gherkin scenario
// "Evidence items are classified per stage with an explicit K": every gold
// item gets exactly one label at the stated K, and an item whose rank cannot
// be determined because the dump cap hid the admitted set is reported as
// unknown rather than guessed.

import { describe, expect, test } from 'bun:test';

import { classifyItem, classifyProbe, type DebugRecord, type GoldEvidence } from './classify';

function record(overrides: Partial<DebugRecord> = {}): DebugRecord {
  return {
    q: 'q',
    candidates_by_channel: { any: ['A', 'B'], like: ['C'], token_set: ['C'] },
    after_coverage_by_rung: { any: ['A', 'B'] },
    after_not: ['A', 'B', 'C'],
    excluded_by_not: [],
    admitted_strict: ['A'],
    admitted_ranked_final: ['A', 'B', 'C'],
    admission_kept: 3,
    admission_dropped: 0,
    zero_reason: null,
    admission_tier: 'strict',
    ...overrides,
  };
}

describe('classifyItem', () => {
  test('admitted inside K maps to admitted_top10 with its rank', () => {
    const r = classifyItem(record(), 'B', 10);
    expect(r.label).toBe('admitted_top10');
    expect(r.rank).toBe(1);
    expect(r.stages.channels).toEqual(['any']);
  });

  test('admitted beyond K maps to admitted_outside_top10', () => {
    const r = classifyItem(record(), 'C', 2);
    expect(r.label).toBe('admitted_outside_top10');
    expect(r.rank).toBe(2);
  });

  test('candidate dropped by admission is distinct from never-candidate', () => {
    const rec = record({ after_not: ['A', 'B', 'D'], admission_kept: 2 });
    expect(classifyItem(rec, 'D', 10).label).toBe('dropped_by_admission');
    expect(classifyItem(rec, 'Z', 10).label).toBe('never_candidate');
  });

  test('NOT exclusion is reported explicitly as excluded_by_not', () => {
    const rec = record({
      candidates_by_channel: { any: ['A', 'B', 'X'] },
      after_not: ['A', 'B'],
      excluded_by_not: ['X'],
    });
    const r = classifyItem(rec, 'X', 10);
    expect(r.label).toBe('excluded_by_not');
    expect(r.stages.in_excluded_by_not).toBe(true);
  });

  test('a candidate dropped before after_not without NOT is dropped_by_coverage', () => {
    const rec = record({
      candidates_by_channel: { any: ['A', 'B', 'C'] },
      after_coverage_by_rung: { any: ['A', 'B'] },
      after_not: ['A', 'B'],
      excluded_by_not: [],
      admitted_ranked_final: ['A', 'B'],
      admission_kept: 2,
    });
    const r = classifyItem(rec, 'C', 10);
    expect(r.label).toBe('dropped_by_coverage');
    expect(r.stages.in_excluded_by_not).toBe(false);
    expect(r.stages.in_after_not).toBe(false);
  });

  test('coverage drop is distinct from a real NOT exclusion', () => {
    const coverage = record({
      candidates_by_channel: { any: ['A', 'C'] },
      after_coverage_by_rung: { any: ['A'] },
      after_not: ['A'],
      admitted_ranked_final: ['A'],
      admission_kept: 1,
    });
    const notExcluded = record({
      candidates_by_channel: { any: ['A', 'C'] },
      after_coverage_by_rung: { any: ['A', 'C'] },
      after_not: ['A'],
      excluded_by_not: ['C'],
      admitted_ranked_final: ['A'],
      admission_kept: 1,
    });
    expect(classifyItem(coverage, 'C', 10).label).toBe('dropped_by_coverage');
    expect(classifyItem(notExcluded, 'C', 10).label).toBe('excluded_by_not');
  });

  test('a cap that hides the admitted set yields ranked_beyond_cap_or_unknown', () => {
    const rec = record({ admitted_ranked_final: ['A'], admission_kept: 3 });
    expect(classifyItem(rec, 'B', 10).label).toBe('ranked_beyond_cap_or_unknown');
  });

  test('label is stable at K=25 vs K=10', () => {
    const ranked = Array.from({ length: 11 }, (_, index) => `N${index}`);
    const rec = record({ admitted_ranked_final: ranked });
    expect(classifyItem(rec, 'N10', 10).label).toBe('admitted_outside_top10');
    expect(classifyItem(rec, 'N10', 25).label).toBe('admitted_top10');
  });
});

describe('classifyProbe', () => {
  const gold = (ids: string[]): GoldEvidence => ({ evidence: ids, category: 'single-hop' });

  test('funnel ALL when every gold item is in top-K', () => {
    const r = classifyProbe(record(), gold(['A', 'B']), 10, false);
    expect(r.funnel).toBe('ALL');
    expect(r.hits).toBe(2);
  });

  test('funnel partial and NONE are exact', () => {
    expect(classifyProbe(record(), gold(['A', 'D']), 10, false).funnel).toBe('partial');
    expect(classifyProbe(record(), gold(['D', 'E']), 10, false).funnel).toBe('NONE');
  });

  test('no evidence gold is probe-level, never item-level', () => {
    expect(classifyProbe(record(), gold([]), 10, false).funnel).toBe('no_evidence_gold');
  });

  test('adversarial probes are flagged', () => {
    expect(classifyProbe(record(), gold(['A']), 10, true).answerable).toBe(false);
  });
});
