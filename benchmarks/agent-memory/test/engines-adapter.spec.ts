import { describe, expect, test } from 'bun:test';

import { engineForCondition } from '../src/config';
import type { MemoryEngine } from '../src/engines/adapter';
import { createFakeEngine } from '../src/testing/fakes';

// A conforming engine must implement the full lifecycle contract.
async function exerciseLifecycle(engine: MemoryEngine): Promise<void> {
  await engine.reset('run-1');
  const latency = await engine.insert('run-1', 'the quick brown fox', { diaId: 'D1:1' });
  expect(typeof latency).toBe('number');
  await engine.flush('run-1');
  const result = await engine.search('run-1', 'quick', 5);
  expect(Array.isArray(result.chunks)).toBe(true);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  await engine.cleanup('run-1');
}

describe('MemoryEngine contract', () => {
  test('a conforming (fake) engine satisfies the lifecycle', async () => {
    const engine = createFakeEngine();
    expect(engine.id).toBe('fake');
    await exerciseLifecycle(engine);
  });

  test('search returns normalised fragments within k', async () => {
    const engine = createFakeEngine();
    await engine.reset('run');
    await engine.insert('run', 'alpha beta');
    await engine.insert('run', 'alpha gamma');
    const result = await engine.search('run', 'alpha', 1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.text).toContain('alpha');
    expect(typeof result.chunks[0]!.score).toBe('number');
  });
});

describe('engineForCondition', () => {
  test('maps conditions to pinned engine labels', () => {
    expect(engineForCondition('no-memory')).toBeNull();
    expect(engineForCondition('mind-v9')).toBe('v9');
    expect(engineForCondition('mind-v10')).toBe('v10');
  });

  test('resolves mind-current to the local checkout engine', () => {
    expect(engineForCondition('mind-current')).toBe('current');
  });

  test('default paid conditions stay the three historical conditions', async () => {
    const { DEFAULT_CONDITIONS, CONDITIONS } = await import('../src/config');
    expect(DEFAULT_CONDITIONS).toEqual(['no-memory', 'mind-v9', 'mind-v10']);
    expect(CONDITIONS).toContain('mind-current');
  });
});
