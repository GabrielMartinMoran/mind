import { describe, expect, test } from 'bun:test';

import { createStore } from '../src/app/store.js';

describe('app store', () => {
  test('returns the initial state and supports shallow patches', () => {
    const store = createStore({ count: 0, label: 'idle' });

    expect(store.getState()).toEqual({ count: 0, label: 'idle' });

    store.setState({ count: 1 });
    expect(store.getState()).toEqual({ count: 1, label: 'idle' });
  });

  test('supports functional patches derived from the current state', () => {
    const store = createStore({ count: 1 });

    store.setState(state => ({ count: state.count + 1 }));

    expect(store.getState().count).toBe(2);
  });

  test('notifies subscribers with the next state on change', () => {
    const store = createStore({ count: 0 });
    const seen: number[] = [];

    store.subscribe(state => seen.push(state.count));
    store.setState({ count: 1 });
    store.setState({ count: 2 });

    expect(seen).toEqual([1, 2]);
  });

  test('does not notify when the patch leaves the state unchanged', () => {
    const store = createStore({ count: 0 });
    let notifications = 0;

    store.subscribe(() => {
      notifications += 1;
    });

    store.setState({ count: 0 });
    store.setState(state => ({ count: state.count }));

    expect(notifications).toBe(0);
  });

  test('unsubscribe stops notifications and is idempotent', () => {
    const store = createStore({ count: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    unsubscribe();
    unsubscribe();
    store.setState({ count: 1 });

    expect(notifications).toBe(0);
  });

  test('select reads through the current state', () => {
    const store = createStore({ count: 3, label: 'ready' });

    expect(store.select(state => state.count + 1)).toBe(4);
    expect(store.select(state => state.label)).toBe('ready');
  });
});
