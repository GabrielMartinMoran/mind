import { describe, expect, test } from 'bun:test';

import {
  CATEGORY_NAMES,
  categoryName,
  conversationTurnCount,
  findSample,
  isLocomoCategory,
  sessionDateTime,
  sessionNumbers,
  sessionTurns,
} from '../src/locomo/types';

import { syntheticDataset } from './fixtures/synthetic-locomo';

describe('LoCoMo category map (dataset order)', () => {
  test('hardcodes 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial', () => {
    expect(CATEGORY_NAMES).toEqual({
      1: 'multi-hop',
      2: 'temporal',
      3: 'open-domain',
      4: 'single-hop',
      5: 'adversarial',
    });
    expect(categoryName(3)).toBe('open-domain');
    expect(categoryName(9)).toBe('unknown:9');
    expect(isLocomoCategory(5)).toBe(true);
    expect(isLocomoCategory(0)).toBe(false);
  });
});

describe('conversation helpers', () => {
  test('reads sessions, turns and timestamps', () => {
    const sample = findSample(syntheticDataset(), 'conv-syn');
    expect(sample).toBeDefined();
    const conversation = sample!.conversation;

    expect(sessionNumbers(conversation)).toEqual([1, 2, 3]);
    expect(sessionTurns(conversation, 1)).toHaveLength(3);
    expect(sessionTurns(conversation, 99)).toEqual([]);
    expect(sessionDateTime(conversation, 2)).toBe('11:00 am on 2 Feb, 2024');
    expect(conversationTurnCount(conversation)).toBe(9);
    expect(findSample(syntheticDataset(), 'nope')).toBeUndefined();
  });
});
