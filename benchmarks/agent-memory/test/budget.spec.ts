import { describe, expect, test } from 'bun:test';

import { BudgetExceededError, BudgetGuard } from '../src/budget';

describe('BudgetGuard', () => {
  test('accumulates cost and exposes the remaining budget', () => {
    const guard = new BudgetGuard({ maxCostUsd: 5 });
    guard.addCost(0.25, 'prompt-a');
    guard.addCost(0.5, 'prompt-b');

    expect(guard.spentUsd).toBeCloseTo(0.75, 10);
    expect(guard.remainingUsd).toBeCloseTo(4.25, 10);
    expect(guard.entries).toHaveLength(2);
    expect(guard.aborted).toBe(false);
  });

  test('allows free stages even without an approved budget', () => {
    const guard = new BudgetGuard({ maxCostUsd: null });
    expect(() => guard.assertCanSpend(0)).not.toThrow();
  });

  test('refuses any paid stage when no budget is approved', () => {
    const guard = new BudgetGuard({ maxCostUsd: null });
    expect(() => guard.assertCanSpend(0.01)).toThrow(BudgetExceededError);
  });

  test('aborts when the accumulated cost exceeds the cap', () => {
    const guard = new BudgetGuard({ maxCostUsd: 5 });
    guard.addCost(4.9, 'big');
    expect(() => guard.addCost(0.2, 'over')).toThrow(BudgetExceededError);
    expect(guard.spentUsd).toBeCloseTo(4.9, 10);
    expect(guard.entries).toHaveLength(1);
  });

  test('assertCanSpend rejects an estimate that would cross the cap', () => {
    const guard = new BudgetGuard({ maxCostUsd: 5 });
    guard.addCost(4.0);
    expect(() => guard.assertCanSpend(1.5)).toThrow(BudgetExceededError);
    expect(() => guard.assertCanSpend(0.5)).not.toThrow();
  });

  test('an aborted guard refuses further spending', () => {
    const guard = new BudgetGuard({ maxCostUsd: 5 });
    guard.abort('credential expired');
    expect(guard.aborted).toBe(true);
    expect(guard.abortReason).toBe('credential expired');
    expect(() => guard.addCost(0)).toThrow(BudgetExceededError);
  });
});
