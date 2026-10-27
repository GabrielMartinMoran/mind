import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SEED,
  SubsetError,
  buildSubsetArtifact,
  mulberry32,
  selectSubset,
} from '../src/locomo/subset';
import { CATEGORY_NAMES, type LocomoCategory } from '../src/locomo/types';

import {
  SYNTHETIC_PER_CATEGORY,
  SYNTHETIC_SAMPLE_ID,
  syntheticDataset,
} from './fixtures/synthetic-locomo';

const dataset = syntheticDataset();

function counts(items: { category: number }[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items)
    result[String(item.category)] = (result[String(item.category)] ?? 0) + 1;
  return result;
}

describe('mulberry32', () => {
  test('is deterministic for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('selectSubset', () => {
  test('is deterministic for the same seed and conversation', () => {
    const first = selectSubset(dataset, {
      conversation: SYNTHETIC_SAMPLE_ID,
      perCategory: 2,
      seed: DEFAULT_SEED,
    });
    const second = selectSubset(dataset, {
      conversation: SYNTHETIC_SAMPLE_ID,
      perCategory: 2,
      seed: DEFAULT_SEED,
    });
    expect(first).toEqual(second);
  });

  test('picks exactly perCategory per category (dataset order)', () => {
    const items = selectSubset(dataset, {
      conversation: SYNTHETIC_SAMPLE_ID,
      perCategory: 3,
      seed: 1234,
    });
    expect(items).toHaveLength(15);
    expect(counts(items)).toEqual({ 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 });
  });

  test('keeps original ids, category, evidence and answer/adversarial answer', () => {
    const items = selectSubset(dataset, {
      conversation: SYNTHETIC_SAMPLE_ID,
      perCategory: 1,
      seed: 7,
    });
    const sample = dataset[0]!;
    for (const item of items) {
      const original = sample.qa[item.questionIndex]!;
      expect(item.id).toBe(`${SYNTHETIC_SAMPLE_ID}#${item.questionIndex}`);
      expect(item.question).toBe(original.question);
      expect(item.evidence).toEqual(original.evidence ?? []);
      expect(item.categoryName).toBe(CATEGORY_NAMES[item.category as LocomoCategory]);
      if (item.adversarial) {
        expect(item.answer).toBe(original.adversarial_answer ?? null);
      } else {
        expect(item.answer).toBe(String(original.answer));
      }
    }
  });

  test('returns all candidates in original order when perCategory exceeds supply', () => {
    const items = selectSubset(dataset, {
      conversation: SYNTHETIC_SAMPLE_ID,
      perCategory: 100,
      seed: 1,
    });
    const cat1 = items.filter(item => item.category === 1).map(item => item.questionIndex);
    expect(cat1).toEqual([...cat1].sort((a, b) => a - b));
    expect(items).toHaveLength(5 * SYNTHETIC_PER_CATEGORY + 1);
  });

  test('throws for an unknown conversation and a non-positive perCategory', () => {
    expect(() => selectSubset(dataset, { conversation: 'none', perCategory: 1, seed: 1 })).toThrow(
      SubsetError
    );
    expect(() =>
      selectSubset(dataset, { conversation: SYNTHETIC_SAMPLE_ID, perCategory: 0, seed: 1 })
    ).toThrow(SubsetError);
  });
});

describe('buildSubsetArtifact', () => {
  test('pilot = 1 per category (5 total) with provenance', () => {
    const artifact = buildSubsetArtifact(dataset, {
      subset: 'pilot',
      conversation: SYNTHETIC_SAMPLE_ID,
      seed: DEFAULT_SEED,
      datasetSha256: 'deadbeef',
    });
    expect(artifact.items).toHaveLength(5);
    expect(artifact.counts).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    expect(artifact.datasetSha256).toBe('deadbeef');
    expect(artifact.perCategory).toBe(1);
    expect(artifact.seed).toBe(DEFAULT_SEED);
  });

  test('full = 6 per category (30 total)', () => {
    const artifact = buildSubsetArtifact(dataset, {
      subset: 'full',
      conversation: SYNTHETIC_SAMPLE_ID,
      seed: DEFAULT_SEED,
      datasetSha256: 'deadbeef',
    });
    expect(artifact.items).toHaveLength(30);
    expect(artifact.counts).toEqual({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 });
  });
});
