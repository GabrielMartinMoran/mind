// ── Fuzzy vocabulary cache invalidation (A2 cross-process + A3 write-path) ──
//
// The P-A fuzzy channel caches the folded global document vocabulary in memory.
// The cache validity key is `{ generation, dataVersion }`:
//   • `generation`  — per-`Database`-handle write counter (`storeGeneration`,
//     bumped by every `FtsHelper` document write) covers writes made through
//     THIS connection;
//   • `dataVersion` — `PRAGMA data_version` read on THIS connection covers
//     writes committed by ANY OTHER connection/process (SQLite leaves it
//     unchanged for same-connection writes, which the generation covers).
// Either differing forces a rebuild, so the cache can never stay permanently
// stale: a write that commits mid-search is reflected by the next search.
//
// The cases below exercise the mechanism across two in-process connections, a
// child process, WAL and rollback journal modes, and the full write-path matrix.

import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import {
  createLinkRepository,
  createMemoryRepository,
  createSearchRepository,
  createSpaceRepository,
  createTagRepository,
} from '../src/store/repositories';
import {
  setSearchDiagnosticsSink,
  type ScoredSearchResult,
  type SearchDiagnostics,
} from '../src/store/repositories/search-repository';
import { initializeDatabase } from '../src/store/schema';
import { FtsHelper, bumpStoreGeneration, recoverTrigramIndex } from '../src/store/shared';
import { createSqliteStore } from '../src/store/sqlite-store';

let counter = 0;
function tempDbPath(): string {
  return join(tmpdir(), `mind-fuzzy-cache-${process.pid}-${Date.now()}-${counter++}.db`);
}

function removeDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
}

/** Run `fn` while collecting diagnostics; always restores the null sink. */
async function withSink<T>(
  fn: () => Promise<T>
): Promise<{ result: T; diagnostics: SearchDiagnostics[] }> {
  const diagnostics: SearchDiagnostics[] = [];
  setSearchDiagnosticsSink(entry => diagnostics.push(entry));
  try {
    const result = await fn();
    return { result, diagnostics };
  } finally {
    setSearchDiagnosticsSink(null);
  }
}

function names(results: ScoredSearchResult[]): string[] {
  return results.map(result => result.name);
}

/** True when the most recent search rebuilt the cached vocabulary. */
function lastRebuilt(diagnostics: SearchDiagnostics[]): boolean {
  const last = diagnostics.at(-1);
  if (last === undefined) throw new Error('no diagnostics captured');
  return last.fuzzy_cache_rebuilt;
}

describe('fuzzy vocabulary cache — cross-connection invalidation (same process)', () => {
  let path: string;
  let a: MindStore;
  let b: MindStore;

  beforeEach(async () => {
    path = tempDbPath();
    a = createSqliteStore(path);
    b = createSqliteStore(path);
    a.createSpace('test', 'Test', ['test']);
    // An always-present document keeps typo-probe searches non-empty, so the
    // fuzzy channel runs and the diagnostics sink is emitted even after a write
    // removes the document under test.
    await a.addMemory('test', 'anchor', 'zephyrion anchor', { tags: ['test'] });
  });

  afterEach(() => {
    a.close();
    b.close();
    removeDb(path);
  });

  test('(a) a memory inserted by another connection is found by a typo after rebuild', async () => {
    // Prime A's vocabulary cache (the anchor keeps the probe non-empty).
    const primed = await withSink(() => a.search('zephyrian'));
    expect(lastRebuilt(primed.diagnostics)).toBe(true);

    await b.addMemory('test', 'zephyr', 'zephyrion signal', { tags: ['test'] });

    const { result, diagnostics } = await withSink(() => a.search('zephyrian'));
    expect(names(result)).toContain('zephyr');
    expect(lastRebuilt(diagnostics)).toBe(true);
  });

  test('(b) an external update removing a word drops the obsolete expansion', async () => {
    await a.addMemory('test', 'm', 'zephyrion signal', { tags: ['test'] });
    expect(names(await a.search('zephyrian'))).toContain('m'); // primes + finds

    const id = a.getMemory('test', 'm')!.id;
    await b.updateMemory(id, { content: 'completely unrelated text' });

    const { result, diagnostics } = await withSink(() => a.search('zephyrian'));
    expect(names(result)).not.toContain('m');
    expect(lastRebuilt(diagnostics)).toBe(true);
  });

  test('(c) an external delete is reflected', async () => {
    await a.addMemory('test', 'm', 'zephyrion signal', { tags: ['test'] });
    expect(names(await a.search('zephyrian'))).toContain('m');

    b.deleteMemoryByName('test', 'm');

    const { result, diagnostics } = await withSink(() => a.search('zephyrian'));
    expect(names(result)).not.toContain('m');
    expect(lastRebuilt(diagnostics)).toBe(true);
  });

  test('(d) searches without intermediate writes do not rebuild repeatedly', async () => {
    await a.addMemory('test', 'm', 'zephyrion signal', { tags: ['test'] });

    const { diagnostics } = await withSink(async () => {
      await a.search('zephyrian');
      await a.search('zephyrian');
      await a.search('zephyrian');
    });

    expect(diagnostics.map(entry => entry.fuzzy_cache_rebuilt)).toEqual([true, false, false]);
  });

  test('(e) multiple alternating external writes and searches stay consistent', async () => {
    for (let round = 0; round < 3; round += 1) {
      const word = `zephyrion${round}`;
      const typo = `zephyrian${round}`;
      await b.addMemory('test', `m${round}`, `${word} signal`, { tags: ['test'] });

      const { result, diagnostics } = await withSink(() => a.search(typo));
      expect(names(result)).toContain(`m${round}`);
      expect(lastRebuilt(diagnostics)).toBe(true);
    }
  });
});

describe('fuzzy vocabulary cache — journal modes', () => {
  test('cross-connection invalidation works in WAL mode (the store default)', async () => {
    const path = tempDbPath();
    const a = createSqliteStore(path);
    const b = createSqliteStore(path);
    try {
      a.createSpace('test', 'Test', ['test']);

      // The store's own connection is in WAL mode.
      const probe = new Database(path);
      const mode = probe.query('PRAGMA journal_mode').get() as { journal_mode: string };
      probe.close();
      expect(mode.journal_mode).toBe('wal');

      expect(names(await a.search('alpha'))).toEqual([]); // prime

      await b.addMemory('test', 'wal-mem', 'zephyrion signal', { tags: ['test'] });
      const { result, diagnostics } = await withSink(() => a.search('zephyrian'));
      expect(names(result)).toContain('wal-mem');
      expect(lastRebuilt(diagnostics)).toBe(true);
    } finally {
      a.close();
      b.close();
      removeDb(path);
    }
  });

  test('cross-connection invalidation also works in rollback (DELETE) journal mode', async () => {
    const path = tempDbPath();
    const aDb = new Database(path, { create: true });
    initializeDatabase(aDb);
    aDb.exec('PRAGMA journal_mode=DELETE');

    const a = openRawStore(aDb);
    const bDb = new Database(path);
    bDb.exec('PRAGMA journal_mode=DELETE');
    bDb.exec('PRAGMA busy_timeout=5000');
    const b = openRawStore(bDb);

    try {
      const mode = aDb.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode).toBe('delete');

      a.createSpace('test', 'Test', ['test']);
      await a.search('alpha'); // prime

      await b.addMemory('test', 'del-mem', 'zephyrion signal', { tags: ['test'] });

      const { result, diagnostics } = await withSink(() => a.search('zephyrian'));
      expect(names(result)).toContain('del-mem');
      expect(lastRebuilt(diagnostics)).toBe(true);
    } finally {
      aDb.close();
      bDb.close();
      removeDb(path);
    }
  });
});

describe('fuzzy vocabulary cache — cross-process invalidation', () => {
  const storeModule = new URL('../src/store/sqlite-store.ts', import.meta.url).pathname;

  /**
   * Spawn a child `bun -e` process against `path` that runs `body` against a
   * freshly opened store. Returns a promise for the exit code (bounded — we
   * await child termination instead of sleeping).
   */
  function runChild(path: string, body: string): Promise<number> {
    const script = `
      const { createSqliteStore } = await import(${JSON.stringify(storeModule)});
      const store = createSqliteStore(process.env.MIND_DB_PATH);
      ${body}
      store.close();
    `;
    const proc = Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, MIND_DB_PATH: path, MIND_RAG: 'false' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    return proc.exited;
  }

  test('a child process insert is detected by the parent on the next search', async () => {
    const path = tempDbPath();
    const parent = createSqliteStore(path);
    try {
      parent.createSpace('test', 'Test', ['test']);
      await parent.search('alpha'); // prime parent vocabulary

      const exit = await runChild(
        path,
        `await store.addMemory('test','proc-insert','zephyrion signal',{tags:['test']});`
      );
      expect(exit).toBe(0);

      const { result, diagnostics } = await withSink(() => parent.search('zephyrian'));
      expect(names(result)).toContain('proc-insert');
      expect(lastRebuilt(diagnostics)).toBe(true);
    } finally {
      parent.close();
      removeDb(path);
    }
  });

  test('a child process delete is detected by the parent on the next search', async () => {
    const path = tempDbPath();
    const parent = createSqliteStore(path);
    try {
      parent.createSpace('test', 'Test', ['test']);
      await parent.addMemory('test', 'anchor', 'zephyrion anchor', { tags: ['test'] });
      await parent.addMemory('test', 'proc-del', 'zephyrion signal', { tags: ['test'] });
      expect(names(await parent.search('zephyrian'))).toContain('proc-del');

      const exit = await runChild(path, `store.deleteMemoryByName('test','proc-del');`);
      expect(exit).toBe(0);

      const { result, diagnostics } = await withSink(() => parent.search('zephyrian'));
      expect(names(result)).not.toContain('proc-del');
      expect(lastRebuilt(diagnostics)).toBe(true);
    } finally {
      parent.close();
      removeDb(path);
    }
  });
});

// ── A3: every document-write path must invalidate the cached vocabulary ──

interface RawStore {
  createSpace(name: string, description: string, tags?: string[]): void;
  addMemory(space: string, name: string, content: string, opts?: any): Promise<any>;
  search(query: string, filter?: any): Promise<ScoredSearchResult[]>;
}

/** Minimal repo wiring over a raw connection (mirrors sqlite-store composition). */
function openRawStore(db: Database): RawStore {
  const fts = new FtsHelper(db);
  const tagRepo = createTagRepository(db);
  const linkRepo = createLinkRepository(db);
  const spaceRepo = createSpaceRepository(db, fts);
  const memoryRepo = createMemoryRepository(db, spaceRepo, tagRepo, linkRepo, fts);
  const searchRepo = createSearchRepository(db, memoryRepo, tagRepo);
  return {
    createSpace: (name, description, tags) => spaceRepo.createSpace(name, description, tags),
    addMemory: (space, name, content, opts) => memoryRepo.addMemory(space, name, content, opts),
    search: (query, filter) => searchRepo.searchMemories(query, filter),
  };
}

describe('fuzzy vocabulary cache — write-path invalidation matrix (A3)', () => {
  let path: string;
  let store: MindStore;

  // Probe shares the ≥3-character prefix with `zephyrion`, so it only matches
  // when the vocabulary contains a document word within OSA ≤2 of it.
  const PROBE = 'zephyrian';

  beforeEach(async () => {
    path = tempDbPath();
    store = createSqliteStore(path);
    store.createSpace('test', 'Test', ['test']);
    store.createSpace('other', 'Other', ['test']);
    // Anchor keeps the typo probe non-empty so the sink is emitted after a
    // write removes the document under test.
    await store.addMemory('test', 'anchor', 'zephyrion anchor', { tags: ['test'] });
  });

  afterEach(() => {
    store.close();
    removeDb(path);
  });

  /** Prime the cache, run `write`, then return the probe search's rebuild flag. */
  async function rebuildAfterWrite(write: () => unknown): Promise<boolean> {
    await store.addMemory('test', 'seed', 'seed document', { tags: ['test'] });
    await store.search(PROBE); // prime
    await write();
    const { diagnostics } = await withSink(() => store.search(PROBE));
    return lastRebuilt(diagnostics);
  }

  test('add invalidates', async () => {
    const rebuilt = await rebuildAfterWrite(() =>
      store.addMemory('test', 'add', 'zephyrion', { tags: ['t'] })
    );
    expect(rebuilt).toBe(true);
  });

  test('update (content) invalidates', async () => {
    const id = (await store.addMemory('test', 'u', 'keep', { tags: ['test'] })).id;
    expect(await rebuildAfterWrite(() => store.updateMemory(id, { content: 'zephyrion' }))).toBe(
      true
    );
  });

  test('update (name) invalidates', async () => {
    const id = (await store.addMemory('test', 'u', 'keep', { tags: ['test'] })).id;
    expect(await rebuildAfterWrite(() => store.updateMemory(id, { name: 'zephyrion-name' }))).toBe(
      true
    );
  });

  test('partial patch (content) invalidates', async () => {
    const id = (await store.addMemory('test', 'p', 'keep', { tags: ['test'] })).id;
    expect(await rebuildAfterWrite(() => store.patchMemory(id, { content: 'zephyrion' }))).toBe(
      true
    );
  });

  test('partial patch (name) invalidates', async () => {
    const id = (await store.addMemory('test', 'p', 'keep', { tags: ['test'] })).id;
    expect(await rebuildAfterWrite(() => store.patchMemory(id, { name: 'zephyrion-name' }))).toBe(
      true
    );
  });

  test('move with a content change invalidates', async () => {
    const id = (await store.addMemory('test', 'mv', 'keep', { tags: ['test'] })).id;
    expect(
      await rebuildAfterWrite(() => store.moveMemory(id, { space: 'other', content: 'zephyrion' }))
    ).toBe(true);
  });

  test('pure relocation (space only) does NOT invalidate — the vocabulary is global and unchanged', async () => {
    const id = (await store.addMemory('test', 'mv', 'keep', { tags: ['test'] })).id;
    // The vocabulary is the folded document vocabulary of ALL spaces, so moving
    // a document without changing its text cannot change it: no rebuild needed.
    expect(await rebuildAfterWrite(() => store.moveMemory(id, { space: 'other' }))).toBe(false);
  });

  test('delete invalidates', async () => {
    const id = (await store.addMemory('test', 'd', 'zephyrion', { tags: ['test'] })).id;
    expect(await rebuildAfterWrite(() => store.deleteMemory(id))).toBe(true);
  });

  test('deleteByName invalidates', async () => {
    await store.addMemory('test', 'd2', 'zephyrion', { tags: ['test'] });
    expect(await rebuildAfterWrite(() => store.deleteMemoryByName('test', 'd2'))).toBe(true);
  });

  test('space delete invalidates', async () => {
    await store.addMemory('other', 'sd', 'zephyrion', { tags: ['test'] });
    expect(await rebuildAfterWrite(() => store.deleteSpace('other'))).toBe(true);
  });

  test('importFromJson invalidates', async () => {
    expect(
      await rebuildAfterWrite(() =>
        store.importFromJson({
          legacy: {
            description: 'legacy',
            memories: [{ name: 'imp', description: 'zephyrion' }],
          },
        })
      )
    ).toBe(true);
  });
});

describe('fuzzy vocabulary cache — recovery / ensureIntegrity seam', () => {
  test('the recovery sequence (recoverTrigramIndex + bumpStoreGeneration) invalidates', async () => {
    const path = tempDbPath();
    const db = new Database(path, { create: true });
    initializeDatabase(db);
    const store = openRawStore(db);
    try {
      store.createSpace('test', 'Test', ['test']);
      await store.addMemory('test', 'm', 'zephyrion signal', { tags: ['test'] });

      const primed = await withSink(() => store.search('zephyrian'));
      expect(lastRebuilt(primed.diagnostics)).toBe(true);

      // Exactly what `repairSearchIndexes()` runs on the store connection after
      // an integrity repair: repopulate the trigram index, then invalidate. The
      // store owns this bump (see sqlite-store.ts); no extra mechanism is needed.
      recoverTrigramIndex(db);
      bumpStoreGeneration(db);

      const after = await withSink(() => store.search('zephyrian'));
      expect(lastRebuilt(after.diagnostics)).toBe(true);
      expect(names(after.result)).toContain('m');
    } finally {
      db.close();
      removeDb(path);
    }
  });
});
