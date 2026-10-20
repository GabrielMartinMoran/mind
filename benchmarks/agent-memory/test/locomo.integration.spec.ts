// Integration tests for LoCoMo ingestion + A1 retrieval against BOTH real
// pinned worktrees. Gated behind BENCH_INTEGRATION=1: they shell out to the
// real `mind` CLI, start a real `mind serve`, and create real SQLite databases
// in a temporary run directory. They never download the real dataset and never
// call an LLM — a tiny synthetic conversation is used instead.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { PINNED_VERSIONS, type EngineVersion, type PinnedEngineVersion } from '../src/config';
import type { MindEngineAdapter, MindEngineOptions } from '../src/engines/mind-engine';
import { createMindV10Engine } from '../src/engines/mind-v10';
import { createMindV9Engine } from '../src/engines/mind-v9';
import { ingestConversation } from '../src/locomo/ingest';
import { startMindServer } from '../src/mind/server';
import { ensureWorktree, worktreePath } from '../src/mind/worktree';

import { SYNTHETIC_SAMPLE_ID, syntheticDataset } from './fixtures/synthetic-locomo';

const enabled = process.env.BENCH_INTEGRATION === '1';
const repoRoot = resolve(import.meta.dir, '../../..');
const workRoot = join(repoRoot, 'benchmarks/agent-memory/.work');
const VERSIONS: readonly PinnedEngineVersion[] = ['v9', 'v10'];
const SPACE = 'locomo/conv-syn';

function makeEngine(
  version: EngineVersion,
  bin: string,
  conditionDir: string,
  onServerPid: (pid: number | undefined) => void
): MindEngineAdapter {
  const options: MindEngineOptions = {
    bin,
    paths: {
      dataDir: conditionDir,
      dbPath: join(conditionDir, 'mind.db'),
      syncRoot: join(conditionDir, 'syncroot'),
    },
    space: SPACE,
    cwd: conditionDir,
    startServer: async serverOptions => {
      const handle = await startMindServer(serverOptions);
      onServerPid(handle.pid);
      return handle;
    },
  };
  return version === 'v9' ? createMindV9Engine(options) : createMindV10Engine(options);
}

describe.skipIf(!enabled)('LoCoMo ingest + A1 (integration)', () => {
  test('ingests the synthetic conversation into both engines and retrieves by dia_id', async () => {
    const dataset = syntheticDataset();
    const runDir = mkdtempSync(join(tmpdir(), 'bench-locomo-int-'));
    try {
      for (const version of VERSIONS) {
        const info = await ensureWorktree({ repoRoot, workRoot, version });
        expect(info.sha.startsWith(PINNED_VERSIONS[version].ref)).toBe(true);

        const conditionDir = join(runDir, version);
        let serverPid: number | undefined;
        const engine = makeEngine(
          version,
          join(worktreePath(workRoot, version), 'mind'),
          conditionDir,
          pid => {
            serverPid = pid;
          }
        );

        const ingest = await ingestConversation(engine, dataset, {
          conversation: SYNTHETIC_SAMPLE_ID,
        });
        expect(ingest.turns).toBe(9);
        expect(ingest.verification.ok).toBe(true);
        expect(ingest.verification.count).toBe(9);
        expect(ingest.verification.distinctNames).toBe(9);

        const rex = await engine.searchRanked('Rex', { limit: 25 });
        expect(rex.rows.map(row => row.ref)).toContain('D1:1');
        expect(rex.rows[0]!.nativeScoreKind).toBe(version === 'v9' ? 'rank' : 'score');

        const kyoto = await engine.searchRanked('Kyoto', { limit: 25 });
        const refs = kyoto.rows.map(row => row.ref);
        expect(refs).toContain('D3:1');
        expect(refs).toContain('D3:2');
        expect(new Set(refs).size).toBe(refs.length);

        await engine.cleanup(SPACE);
        if (serverPid !== undefined) {
          expect(() => process.kill(serverPid as number, 0)).toThrow();
        }
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 600_000);
});
