import { describe, expect, test } from 'bun:test';

import type { IngestEngine } from '../src/locomo/ingest';
import {
  LocomoIngestError,
  buildTurnContent,
  conversationTurns,
  ingestConversation,
} from '../src/locomo/ingest';
import type { LocomoConversation } from '../src/locomo/types';
import type { MemorySetVerification } from '../src/mind/inspect';

import { SYNTHETIC_SAMPLE_ID, syntheticDataset } from './fixtures/synthetic-locomo';

describe('buildTurnContent', () => {
  test('formats [date_time] speaker: text and appends a photo line when present', () => {
    expect(buildTurnContent('10:00 am on 1 Jan, 2024', 'Ada', 'Hello')).toBe(
      '[10:00 am on 1 Jan, 2024] Ada: Hello'
    );
    expect(buildTurnContent('t', 'Bob', 'Hi', 'a sunset')).toBe('[t] Bob: Hi\n[Photo: a sunset]');
  });
});

describe('conversationTurns', () => {
  test('flattens synthetic turns in session/turn order with dia_id names and tags', () => {
    const turns = conversationTurns(syntheticDataset(), SYNTHETIC_SAMPLE_ID);
    expect(turns).toHaveLength(9);
    expect(turns[0]!.diaId).toBe('D1:1');
    expect(turns[0]!.content).toBe(
      '[10:00 am on 1 Jan, 2024] Ada: I adopted a golden retriever puppy named Rex.'
    );
    expect(turns[0]!.tags).toEqual(['locomo', 'session:1']);
    expect(turns[8]!.diaId).toBe('D3:3');
    expect(turns[8]!.tags).toEqual(['locomo', 'session:3']);
  });

  test('iterates non-contiguous sessions ascending and pairs the right date_time', () => {
    const conversation: LocomoConversation = {
      speaker_a: 'A',
      speaker_b: 'B',
      session_3_date_time: 'third',
      session_3: [{ speaker: 'A', dia_id: 'D3:1', text: 'three' }],
      session_7_date_time: 'seventh',
      session_7: [{ speaker: 'B', dia_id: 'D7:1', text: 'seven' }],
      session_1_date_time: 'first',
      session_1: [{ speaker: 'A', dia_id: 'D1:1', text: 'one' }],
    };
    const dataset = [{ sample_id: 'conv-x', conversation, qa: [] }];
    const turns = conversationTurns(dataset, 'conv-x');
    expect(turns.map(t => t.diaId)).toEqual(['D1:1', 'D3:1', 'D7:1']);
    expect(turns.map(t => t.sessionDateTime)).toEqual(['first', 'third', 'seventh']);
  });

  test('throws for an unknown conversation', () => {
    expect(() => conversationTurns(syntheticDataset(), 'nope')).toThrow(LocomoIngestError);
  });
});

interface RecordedInsert {
  readonly name: string;
  readonly content: string;
  readonly tags: readonly string[];
}

function fakeIngestEngine(verification: (expected: readonly string[]) => MemorySetVerification): {
  engine: IngestEngine;
  inserts: RecordedInsert[];
  resetCalls: string[];
} {
  const inserts: RecordedInsert[] = [];
  const resetCalls: string[] = [];
  const engine: IngestEngine = {
    space: 'locomo/conv-26',
    async reset(runKey: string) {
      resetCalls.push(runKey);
      inserts.length = 0;
    },
    async insert(_userKey, text, meta) {
      inserts.push({ name: meta?.diaId ?? '?', content: text, tags: meta?.tags ?? [] });
      return 0;
    },
    async ingestDone(expected) {
      return verification(expected);
    },
  };
  return { engine, inserts, resetCalls };
}

const okVerification = (expected: readonly string[]): MemorySetVerification => ({
  ok: true,
  expected: expected.length,
  count: expected.length,
  distinctNames: expected.length,
  missing: [],
  unexpected: [],
  detail: 'ok',
});

describe('ingestConversation', () => {
  test('ingests every turn into the engine space and verifies the dia_id set', async () => {
    const { engine, inserts, resetCalls } = fakeIngestEngine(okVerification);
    const result = await ingestConversation(engine, syntheticDataset(), {
      conversation: SYNTHETIC_SAMPLE_ID,
    });

    expect(resetCalls).toEqual(['locomo/conv-26']);
    expect(inserts).toHaveLength(9);
    expect(inserts.map(i => i.name)).toEqual([
      'D1:1',
      'D1:2',
      'D1:3',
      'D2:1',
      'D2:2',
      'D2:3',
      'D3:1',
      'D3:2',
      'D3:3',
    ]);
    expect(inserts[0]!.tags).toEqual(['locomo', 'session:1']);
    expect(result.turns).toBe(9);
    expect(result.sessions).toBe(3);
    expect(result.verification.ok).toBe(true);
    expect(result.msPerTurn).toBeGreaterThanOrEqual(0);
  });

  test('throws when the stored set does not match the dia_id set', async () => {
    const { engine } = fakeIngestEngine(expected => ({
      ok: false,
      expected: expected.length,
      count: expected.length - 1,
      distinctNames: expected.length - 1,
      missing: ['D3:3'],
      unexpected: [],
      detail: 'missing',
    }));
    await expect(
      ingestConversation(engine, syntheticDataset(), { conversation: SYNTHETIC_SAMPLE_ID })
    ).rejects.toThrow(LocomoIngestError);
  });
});
