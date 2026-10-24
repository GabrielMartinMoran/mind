import { describe, expect, test } from 'bun:test';

import { createSearchController } from '../src/app/search-controller.js';
import { createStore } from '../src/app/store.js';

interface SearchRequest {
  q?: string;
  space?: string;
  tag?: string;
  tier?: number;
  confidence?: string;
  semantic?: string;
  limit?: number;
  offset?: number;
}

interface SearchResponse {
  results: unknown[];
  total: number;
  hasMore: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ManualTimers {
  setTimeout: (callback: () => void, ms?: number) => number;
  clearTimeout: (id: number) => void;
  advance: (ms: number) => void;
  pending: () => number;
}

function createManualTimers(): ManualTimers {
  let now = 0;
  let nextId = 0;
  const queue = new Map<number, { callback: () => void; at: number }>();

  return {
    setTimeout(callback, ms = 0) {
      const id = ++nextId;
      queue.set(id, { callback, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of Array.from(queue)) {
        if (entry.at <= now) {
          queue.delete(id);
          entry.callback();
        }
      }
    },
    pending() {
      return queue.size;
    },
  };
}

interface ApiCall {
  params: SearchRequest;
  signal: AbortSignal | undefined;
  deferred: Deferred<SearchResponse>;
}

function createApi() {
  const calls: ApiCall[] = [];
  const searchApi = (params: SearchRequest, options?: { signal?: AbortSignal }) => {
    const deferredResponse = deferred<SearchResponse>();
    calls.push({ params, signal: options?.signal, deferred: deferredResponse });
    return deferredResponse.promise;
  };
  return { calls, searchApi };
}

function createHistory() {
  const entries: { method: 'pushState' | 'replaceState'; url: string }[] = [];
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      entries.push({ method: 'pushState', url });
    },
    replaceState(_state: unknown, _title: string, url: string) {
      entries.push({ method: 'replaceState', url });
    },
  };
  return { entries, history };
}

function createEventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type: string, listener: () => void) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of Array.from(listeners.get(type) ?? [])) listener();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function setup(initialState: Record<string, unknown> = {}) {
  const store = createStore(initialState);
  const api = createApi();
  const history = createHistory();
  const location = { pathname: '/spaces/demo', search: '' };
  const eventTarget = createEventTarget();
  const timers = createManualTimers();

  const controller = createSearchController({
    store,
    searchApi: api.searchApi,
    history: history.history,
    location,
    eventTarget,
    debounceMs: 200,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  const searchState = () => (store.getState() as any).search;

  return { store, api, history, location, eventTarget, timers, controller, searchState };
}

describe('search controller', () => {
  test('defaults semantic off and sends semantic=off explicitly', () => {
    const { api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.params).toMatchObject({ q: 'auth', semantic: 'off' });
  });

  test('debounces query changes and runs filter changes immediately', () => {
    const { api, timers, controller } = setup();

    controller.setQuery('auth');
    expect(api.calls).toHaveLength(0);

    timers.advance(199);
    expect(api.calls).toHaveLength(0);

    timers.advance(1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.params.q).toBe('auth');

    controller.setFilter('tier', 2);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.params).toMatchObject({ q: 'auth', tier: 2 });
  });

  test('a new query cancels the pending debounce', () => {
    const { api, timers, controller } = setup();

    controller.setQuery('au');
    timers.advance(100);
    controller.setQuery('auth');
    timers.advance(200);

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.params.q).toBe('auth');
  });

  test('aborts the previous request and ignores stale responses', async () => {
    const { searchState, api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    expect(api.calls).toHaveLength(1);

    controller.setQuery('graph');
    expect(api.calls[0]!.signal?.aborted).toBe(true);

    timers.advance(200);
    expect(api.calls).toHaveLength(2);

    api.calls[1]!.deferred.resolve({
      results: [{ name: 'graph-hit' }],
      total: 1,
      hasMore: false,
    });
    await flush();
    expect(searchState().results).toEqual([{ name: 'graph-hit' }]);

    api.calls[0]!.deferred.resolve({
      results: [{ name: 'auth-hit' }],
      total: 1,
      hasMore: false,
    });
    await flush();

    expect(searchState().results).toEqual([{ name: 'graph-hit' }]);
    expect(searchState().status).toBe('success');
  });

  test('an empty query without filters clears state and makes no request', async () => {
    const { searchState, api, controller } = setup();

    controller.setQuery('auth');
    controller.clearQuery();
    await flush();

    expect(api.calls).toHaveLength(0);
    expect(searchState()).toMatchObject({
      query: '',
      results: [],
      total: 0,
      hasMore: false,
      status: 'idle',
    });
  });

  test('never writes the URL; app.js is the single URL owner', async () => {
    const { history, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    controller.setFilter('tier', 2);
    controller.setSemantic(true);
    controller.clearQuery();

    expect(history.entries).toHaveLength(0);
  });

  test('applyFilters with run=false keeps the slice in sync without a request', () => {
    const { api, history, searchState, timers, controller } = setup();

    controller.applyFilters(
      { q: '', tag: 'cat:decision', tiers: [1, 3], confidence: '', semantic: false },
      { run: false }
    );
    timers.advance(500);

    expect(api.calls).toHaveLength(0);
    expect(history.entries).toHaveLength(0);
    expect(searchState().filters).toMatchObject({ tag: 'cat:decision', tiers: [1, 3] });
  });

  test('setScope updates the filter without writing the URL or issuing a request', () => {
    const { api, history, searchState, timers, controller } = setup();

    controller.setScope('projects/mind');

    expect(searchState().filters.space).toBe('projects/mind');
    expect(api.calls).toHaveLength(0);
    expect(history.entries).toHaveLength(0);
    expect(timers.pending()).toBe(0);

    controller.setScope(null);
    expect(searchState().filters.space).toBe('*');
    expect(api.calls).toHaveLength(0);
    expect(history.entries).toHaveLength(0);
  });

  test('cancelPending drops a pending debounce and preserves query and filters', () => {
    const { api, searchState, timers, controller } = setup();

    controller.setQuery('auth');
    controller.setFilter('tag', 'type:project');
    // setFilter runs immediately, so start a fresh debounce for the query.
    controller.setQuery('auth tokens');
    expect(timers.pending()).toBe(1);
    const callsBefore = api.calls.length;

    controller.setScope(null);
    controller.cancelPending();

    timers.advance(500);
    expect(api.calls).toHaveLength(callsBefore);
    expect(searchState().query).toBe('auth tokens');
    expect(searchState().filters.tag).toBe('type:project');
  });

  test('restoreFromUrl adopts the URL state and searches immediately', async () => {
    const { searchState, api, location, controller } = setup();
    location.pathname = '/spaces/demo';
    location.search = '?q=auth&tier=2&confidence=high&semantic=on';

    controller.restoreFromUrl();
    await flush();

    expect(searchState()).toMatchObject({
      query: 'auth',
      filters: { tier: 2, confidence: 'high' },
      semantic: true,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.params).toMatchObject({
      q: 'auth',
      tier: 2,
      confidence: 'high',
      semantic: 'on',
    });
  });

  test('drops invalid URL filters on restore without writing the URL', async () => {
    const { history, location, searchState, timers, controller } = setup();
    location.pathname = '/spaces/demo';
    location.search = '?q=auth&tier=9&unknown=1';

    controller.restoreFromUrl();
    timers.advance(0);
    await flush();

    expect(history.entries).toHaveLength(0);
    expect(searchState().filters.tier).toBeNull();
    expect(searchState().query).toBe('auth');
  });

  test('popstate restores the previous search', async () => {
    const { searchState, api, location, eventTarget, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.resolve({ results: [{ name: 'auth-hit' }], total: 1, hasMore: false });
    await flush();

    location.search = '?q=graph';
    eventTarget.emit('popstate');
    await flush();

    expect(searchState().query).toBe('graph');
    expect(api.calls.at(-1)!.params.q).toBe('graph');
  });

  test('loadMore requests the next offset and appends results', async () => {
    const { searchState, api, history, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.resolve({
      results: Array.from({ length: 30 }, (_, index) => ({ name: `hit-${index}` })),
      total: 45,
      hasMore: true,
    });
    await flush();

    const historyCount = history.entries.length;
    controller.loadMore();

    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.params.offset).toBe(30);
    expect(history.entries).toHaveLength(historyCount);

    api.calls[1]!.deferred.resolve({
      results: Array.from({ length: 15 }, (_, index) => ({ name: `more-${index}` })),
      total: 45,
      hasMore: false,
    });
    await flush();

    expect(searchState().results).toHaveLength(45);
    expect(searchState().results[0]).toEqual({ name: 'hit-0' });
    expect(searchState().results[30]).toEqual({ name: 'more-0' });
    expect(searchState().total).toBe(45);
    expect(searchState().hasMore).toBe(false);
  });

  test('reports errors and retries the last request', async () => {
    const { searchState, api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.reject(new Error('network down'));
    await flush();

    expect(searchState().status).toBe('error');
    expect(searchState().error).toContain('network down');

    controller.retry();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.params).toMatchObject({ q: 'auth', semantic: 'off' });

    api.calls[1]!.deferred.resolve({ results: [{ name: 'auth-hit' }], total: 1, hasMore: false });
    await flush();

    expect(searchState().status).toBe('success');
    expect(searchState().error).toBeNull();
  });

  test('disables semantic when the server reports rag_enabled=false', () => {
    const { searchState, api, timers, controller } = setup({ status: { rag_enabled: false } });

    controller.setSemantic(true);
    controller.setQuery('auth');
    timers.advance(200);

    expect(searchState().semantic).toBe(true);
    expect(api.calls.at(-1)!.params.semantic).toBe('off');
  });

  test('uses semantic when the user opts in and RAG is enabled', () => {
    const { api, timers, controller } = setup({ status: { rag_enabled: true } });

    controller.setSemantic(true);
    controller.setQuery('auth');
    timers.advance(200);

    expect(api.calls.at(-1)!.params.semantic).toBe('on');
  });

  test('ignores a success that resolves between a keystroke and the debounce', async () => {
    const { searchState, api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    expect(api.calls).toHaveLength(1);

    // A keystroke invalidates the in-flight request before the new one starts.
    controller.setQuery('graph');
    expect(api.calls).toHaveLength(1);

    api.calls[0]!.deferred.resolve({
      results: [{ name: 'auth-hit' }],
      total: 1,
      hasMore: false,
    });
    await flush();

    expect(searchState().results).toEqual([]);
    expect(searchState().status).not.toBe('success');

    timers.advance(200);
    expect(api.calls).toHaveLength(2);
    api.calls[1]!.deferred.resolve({
      results: [{ name: 'graph-hit' }],
      total: 1,
      hasMore: false,
    });
    await flush();

    expect(searchState().results).toEqual([{ name: 'graph-hit' }]);
    expect(searchState().status).toBe('success');
  });

  test('discards a stale error from a superseded request', async () => {
    const { searchState, api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    expect(api.calls).toHaveLength(1);

    controller.setQuery('graph');
    api.calls[0]!.deferred.reject(new Error('network down'));
    await flush();

    expect(searchState().status).not.toBe('error');
    expect(searchState().error).toBeNull();

    timers.advance(200);
    api.calls[1]!.deferred.resolve({ results: [{ name: 'graph-hit' }], total: 1, hasMore: false });
    await flush();

    expect(searchState().status).toBe('success');
    expect(searchState().error).toBeNull();
  });

  test('discards a stale load-more append', async () => {
    const { searchState, api, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.resolve({
      results: Array.from({ length: 30 }, (_, index) => ({ name: `hit-${index}` })),
      total: 45,
      hasMore: true,
    });
    await flush();

    controller.loadMore();
    expect(api.calls).toHaveLength(2);

    controller.setQuery('graph');
    api.calls[1]!.deferred.resolve({
      results: [{ name: 'stale-more' }],
      total: 45,
      hasMore: false,
    });
    await flush();

    expect(searchState().results).toHaveLength(30);
    expect(searchState().results[0]).toEqual({ name: 'hit-0' });
    expect(searchState().hasMore).toBe(true);
  });

  test('clearQuery preserves filters and searches again when filters remain', async () => {
    const { searchState, api, history, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.resolve({ results: [{ name: 'auth-hit' }], total: 1, hasMore: false });
    await flush();

    controller.setFilter('tag', 'cat:decision');
    controller.clearQuery();

    expect(searchState().query).toBe('');
    expect(searchState().filters.tag).toBe('cat:decision');
    expect(api.calls.at(-1)!.params).toMatchObject({ tag: 'cat:decision', semantic: 'off' });
    expect(api.calls.at(-1)!.params.q).toBeUndefined();
    expect(history.entries).toHaveLength(0);
  });

  test('clearAll resets query, filters and offset and pushes the canonical URL', async () => {
    const { searchState, api, history, location, timers, controller } = setup();

    controller.setSemantic(true);
    controller.setQuery('auth');
    timers.advance(200);
    api.calls[0]!.deferred.resolve({
      results: Array.from({ length: 30 }, (_, index) => ({ name: `hit-${index}` })),
      total: 45,
      hasMore: true,
    });
    await flush();

    controller.loadMore();
    api.calls[1]!.deferred.resolve({ results: [{ name: 'more' }], total: 45, hasMore: false });
    await flush();
    expect(searchState().offset).toBe(30);

    // The browser URL reflects the active search when Clear filters is pressed.
    location.search = '?q=auth&semantic=on';
    controller.clearAll();

    expect(searchState()).toMatchObject({
      query: '',
      semantic: false,
      offset: 0,
      results: [],
      total: 0,
      hasMore: false,
      status: 'idle',
      error: null,
      filters: { space: '*', tag: '', tier: null, tiers: [], confidence: null },
    });
    expect(history.entries).toHaveLength(0);
  });

  test('destroy clears timers, aborts requests, and removes listeners', () => {
    const { api, eventTarget, timers, controller } = setup();

    controller.setQuery('auth');
    timers.advance(200);
    expect(api.calls[0]!.signal?.aborted).toBe(false);
    expect(eventTarget.count('popstate')).toBe(1);

    controller.destroy();
    controller.destroy();

    expect(api.calls[0]!.signal?.aborted).toBe(true);
    expect(eventTarget.count('popstate')).toBe(0);

    controller.setQuery('graph');
    expect(timers.pending()).toBe(0);
    timers.advance(1000);
    expect(api.calls).toHaveLength(1);
  });
});
