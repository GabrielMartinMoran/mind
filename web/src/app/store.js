// @ts-check

/**
 * Minimal observable state container. It performs shallow immutable updates,
 * notifies subscribers only when a value actually changes, and has no DOM or
 * network concerns.
 */

/**
 * @template {Record<string, any>} S
 * @typedef {(state: S) => Partial<S>} StateUpdater
 */
/** @template S @typedef {(state: S) => void} Listener */

/**
 * @template {Record<string, any>} S
 * @param {S} [initialState]
 */
export function createStore(initialState = /** @type {S} */ ({})) {
  /** @type {S} */
  let state = { ...initialState };
  /** @type {Set<Listener<S>>} */
  const listeners = new Set();

  /**
   * @param {Partial<S> | StateUpdater<S>} patch
   * @returns {S}
   */
  function setState(patch) {
    const proposed = typeof patch === 'function' ? patch(state) : patch;
    if (!proposed) return state;

    let changed = false;
    for (const key of Object.keys(proposed)) {
      if (!Object.is(state[key], proposed[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return state;

    state = { ...state, ...proposed };
    for (const listener of Array.from(listeners)) listener(state);
    return state;
  }

  /** @returns {S} */
  function getState() {
    return state;
  }

  /**
   * @param {Listener<S>} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  /**
   * @template T
   * @param {(state: S) => T} selector
   * @returns {T}
   */
  function select(selector) {
    return selector(state);
  }

  return { getState, setState, subscribe, select };
}
