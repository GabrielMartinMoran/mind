// Shared MemoryEngine implementation for the Mind engines.
//
// `mind-v9`, `mind-v10` and `mind-current` are the SAME concrete implementation
// driven by the engine's own `mind` CLI (ingestion) and its own `mind serve`
// HTTP API (retrieval). v9 differs in the `/api/search` payload it emits (a
// `rank` field, no `limit` parameter); v10 and current share the additive
// `score`/`confidence`/`methods` contract and accept `limit`. That difference is
// handled by `mind-normalize`. The class never calls `read`/`memory_read` (which
// mutate access counts and tiers).

import { existsSync, mkdirSync, rmSync } from 'node:fs';

import type { EngineVersion } from '../config';
import type { CommandRunner } from '../exec';
import { MindCli, type MindPaths } from '../mind/cli';
import { verifyMemorySet, type MemorySetVerification } from '../mind/inspect';
import {
  startMindServer,
  type MindServerHandle,
  type StartMindServerOptions,
} from '../mind/server';

import type {
  EngineFragment,
  EngineInsertItem,
  EngineInsertMeta,
  EngineSearchResult,
  MemoryEngine,
} from './adapter';
import { normalizeSearchItems, type MindSearchResponse } from './mind-normalize';

export class MindEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MindEngineError';
  }
}

export interface MindEngineOptions {
  /** Absolute path to `<worktree>/mind`. */
  readonly bin: string;
  readonly paths: MindPaths;
  /** Space every memory is written to / searched in (e.g. `locomo/conv-26`). */
  readonly space: string;
  readonly cwd?: string;
  readonly runner?: CommandRunner;
  /** Enable embeddings for ingest and query-time retrieval (off by default). */
  readonly rag?: boolean;
  /** Override server startup (tests inject a fake); defaults to `startMindServer`. */
  readonly startServer?: (options: StartMindServerOptions) => Promise<MindServerHandle>;
  readonly fetchFn?: typeof fetch;
  readonly searchDiag?: boolean;
  readonly baseEnv?: Record<string, string | undefined>;
}

/**
 * `MemoryEngine` plus the A1-specific surface: ranked search rows (v9 `rank` /
 * v10 `score` normalised) and an ingestion verification that compares the
 * stored memory set against the expected `dia_id`s.
 */
export interface MindEngineAdapter extends MemoryEngine {
  readonly version: EngineVersion;
  readonly space: string;
  searchRanked(
    query: string,
    options: { space?: string; limit: number }
  ): Promise<MindSearchResponse>;
  ingestDone(expectedNames: readonly string[]): Promise<MemorySetVerification>;
}

export function createMindEngine(
  version: EngineVersion,
  options: MindEngineOptions
): MindEngineAdapter {
  const cli = new MindCli({
    bin: options.bin,
    paths: options.paths,
    cwd: options.cwd,
    rag: options.rag,
    runner: options.runner,
    baseEnv: options.baseEnv,
  });

  const insertedNames = new Map<string, string[]>();
  let nameCounter = 0;
  let server: MindServerHandle | null = null;
  let serverStarting: Promise<MindServerHandle> | null = null;

  const ensureServer = async (): Promise<MindServerHandle> => {
    if (server) return server;
    if (!serverStarting) {
      const start = options.startServer ?? startMindServer;
      serverStarting = start({
        bin: options.bin,
        paths: options.paths,
        cwd: options.cwd,
        rag: options.rag,
        searchDiag: options.searchDiag,
        fetchFn: options.fetchFn,
        baseEnv: options.baseEnv,
      }).then(handle => {
        server = handle;
        return handle;
      });
    }
    return serverStarting;
  };

  const searchRanked = async (
    query: string,
    searchOptions: { space?: string; limit: number }
  ): Promise<MindSearchResponse> => {
    const space = searchOptions.space ?? options.space;
    const handle = await ensureServer();
    const params = new URLSearchParams({ q: query, space });
    // v9 has no pagination; v10/current accept and default to 25. All are sliced locally.
    if (version !== 'v9') params.set('limit', String(searchOptions.limit));
    const url = `${handle.baseUrl}/api/search?${params.toString()}`;

    const started = performance.now();
    const response = await (options.fetchFn ?? fetch)(url);
    if (!response.ok) {
      throw new MindEngineError(`/api/search responded with status ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const latencyMs = performance.now() - started;
    const items = Array.isArray(payload) ? payload : [];
    return {
      rows: normalizeSearchItems(items, version).slice(0, Math.max(0, searchOptions.limit)),
      latencyMs,
    };
  };

  const engine: MindEngineAdapter = {
    id: `mind-${version}`,
    version,
    space: options.space,
    searchRanked,

    async reset(runKey: string): Promise<void> {
      mkdirSync(options.paths.dataDir, { recursive: true });
      if (existsSync(options.paths.dbPath)) rmSync(options.paths.dbPath, { force: true });
      insertedNames.set(runKey, []);
      await cli.exec(['create', options.space, `LoCoMo ${options.space}`, '--tags', 'locomo']);
    },

    async insert(_userKey: string, text: string, meta?: EngineInsertMeta): Promise<number> {
      const name = meta?.diaId ?? `mem-${nameCounter++}`;
      const tags = meta?.tags && meta.tags.length > 0 ? meta.tags : ['locomo'];
      const started = performance.now();
      await cli.exec(['add', options.space, name, text, '--tags', tags.join(','), '--tier', '3']);
      return performance.now() - started;
    },

    async insertMany(userKey: string, items: readonly EngineInsertItem[]): Promise<number> {
      let count = 0;
      for (const item of items) {
        await engine.insert(userKey, item.text, item.meta);
        count++;
      }
      return count;
    },

    async flush(runKey: string): Promise<void> {
      const names = insertedNames.get(runKey) ?? [];
      if (names.length === 0) return;
      const verification = verifyMemorySet(options.paths.dbPath, options.space, names);
      if (!verification.ok) {
        throw new MindEngineError(`ingest verification failed: ${verification.detail}`);
      }
    },

    async search(_userKey: string, query: string, k: number): Promise<EngineSearchResult> {
      const { rows, latencyMs } = await searchRanked(query, { limit: k });
      return {
        chunks: rows.map(
          (row): EngineFragment => ({
            text: row.content,
            score: row.nativeScore ?? 0,
            source: row.ref,
            name: row.ref,
            spaceName: row.space,
          })
        ),
        latencyMs,
        nativeScoreKind: version === 'v9' ? 'rank' : 'score',
      };
    },

    // No by-id endpoint exists; retrieve falls back to a documented search-by-name.
    async retrieve(_userKey: string, id: string): Promise<EngineFragment | null> {
      const { rows } = await searchRanked(id, { limit: 5 });
      const row = rows.find(candidate => candidate.ref === id);
      if (!row) return null;
      return {
        text: row.content,
        score: row.nativeScore ?? 0,
        source: id,
        name: id,
        spaceName: row.space,
      };
    },

    async ingestDone(expectedNames: readonly string[]): Promise<MemorySetVerification> {
      return verifyMemorySet(options.paths.dbPath, options.space, expectedNames);
    },

    async cleanup(runKey: string): Promise<void> {
      insertedNames.delete(runKey);
      const current = server;
      server = null;
      serverStarting = null;
      if (current) await current.stop();
    },
  };

  return engine;
}

/**
 * The invoking checkout as an engine. It reports the explicit `current`
 * identity (never a simulated v10) while sharing the v10-era API contract.
 */
export function createMindCurrentEngine(options: MindEngineOptions): MindEngineAdapter {
  return createMindEngine('current', options);
}
