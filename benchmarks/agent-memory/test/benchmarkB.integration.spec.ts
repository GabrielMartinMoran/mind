// Integration tests for the benchmark B runner against the REAL filesystem.
// Gated behind BENCH_INTEGRATION=1; no LLM, no OpenCode: the session executor is
// a fake driver, but fixture copies, directory layout the fresh-DB
// initialization (`mind status`) all run for real.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import type { BSessionExecutor } from '../src/benchmarkB/runner';
import { runScenarioRun } from '../src/benchmarkB/runner';
import type { BChildResult } from '../src/benchmarkB/scenario';
import { B1_SCENARIO } from '../src/benchmarkB/scenarios/b1/index';
import { B10_SCENARIO } from '../src/benchmarkB/scenarios/b10/index';
import { B4_SCENARIO } from '../src/benchmarkB/scenarios/b4/index';
import { B5_SCENARIO } from '../src/benchmarkB/scenarios/b5/index';
import { B6_SCENARIO } from '../src/benchmarkB/scenarios/b6/index';
import { B7_OLD_NAME, B7_SCENARIO, B7_SPACE } from '../src/benchmarkB/scenarios/b7/index';
import {
  B8_BACKGROUND,
  B8_CHECKLIST,
  B8_SCENARIO,
  B8_SPACE,
} from '../src/benchmarkB/scenarios/b8/index';
import { B9_SCENARIO } from '../src/benchmarkB/scenarios/b9/index';
import { BudgetGuard } from '../src/budget';
import { runCommand } from '../src/exec';
import { createFakeSessionDriver } from '../src/testing/fakes';

const REPO_ROOT = join(import.meta.dir, '../../..');
const HARNESS_ROOT = join(import.meta.dir, '..');
const enabled = process.env.BENCH_INTEGRATION === '1';

function fakeExecutor(): BSessionExecutor {
  const driver = createFakeSessionDriver([
    { text: 'b1#0', cost: 0 },
    { text: 'b1#1', cost: 0 },
    { text: 'b4#0', cost: 0 },
    { text: 'b4#1', cost: 0, children: ['ses_child_int'] },
    { text: 'b5#0', cost: 0 },
    { text: 'b5#1', cost: 0 },
    { text: 'b6#0', cost: 0 },
    { text: 'b6#1', cost: 0 },
    { text: 'b7#0', cost: 0 },
    { text: 'b7#1', cost: 0 },
    { text: 'b9#0', cost: 0 },
    { text: 'b9#1', cost: 0 },
    { text: 'b9#2', cost: 0 },
    { text: 'b8#0', cost: 0 },
    { text: 'b8#1', cost: 0 },
  ]);
  return async job => {
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    const children: BChildResult[] = (await driver.children(result.sessionId)).map(id => ({
      sessionId: id,
      finalText: '',
      memoryCalls: 0,
      toolCalls: 0,
      tokens: null,
      costUsd: 0,
      latencyMs: 0,
      steps: 0,
      finish: null,
      error: null,
    }));
    return {
      status: 'ok',
      sessionId: result.sessionId,
      finalText: result.finalText,
      toolCalls: result.toolCalls,
      memoryCalls: result.memoryCalls,
      model: result.model,
      tokens: result.tokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      steps: result.steps,
      finish: result.finish,
      error: null,
      errorType: null,
      isolationOk: true,
      children,
      rawMessages: { data: [] },
    };
  };
}

describe.skipIf(!enabled)('scenario runner (integration)', () => {
  test('copies fixtures, initializes a fresh empty DB and captures children', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-int-'));
    try {
      const run = await runScenarioRun(
        {
          runId: 'run-int',
          runDir,
          // `mind-v9` here uses the repo's own `mind` only to exercise the real
          // fresh-DB init path; the fake executor never sends a prompt.
          conditions: ['mind-v9'],
          scenarios: [
            B1_SCENARIO,
            B4_SCENARIO,
            B5_SCENARIO,
            B6_SCENARIO,
            B7_SCENARIO,
            B9_SCENARIO,
            B8_SCENARIO,
            B10_SCENARIO,
          ],
          limits: { steps: 1, timeoutMs: 1000 },
          budget: new BudgetGuard({ maxCostUsd: 0 }),
          stdout: () => undefined,
          stderr: () => undefined,
        },
        {
          fixtureDirFor: scenario => join(HARNESS_ROOT, scenario.fixture),
          worktrees: { v9: REPO_ROOT },
          executor: fakeExecutor(),
          runner: runCommand,
        }
      );

      // Fixtures were copied onto the real filesystem.
      const b1Workspace = join(runDir, 'scenarios', 'b1', 'mind-v9', 'workspace');
      expect(existsSync(join(b1Workspace, 'package.json'))).toBe(true);
      expect(existsSync(join(b1Workspace, 'src', 'tasks.ts'))).toBe(true);

      // A fresh, empty database was initialized by the engine's own CLI.
      const dbPath = join(runDir, 'scenarios', 'b1', 'mind-v9', 'mind.db');
      expect(existsSync(dbPath)).toBe(true);
      const db = new Database(dbPath, { readonly: true });
      const count = db.query('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      db.close();
      expect(count.n).toBe(0);

      // Child sessions were captured on the real path too.
      const b4 = run.results.find(result => result.scenarioId === 'b4');
      expect(b4?.childCount).toBe(1);
      expect(b4?.childResults[0]?.sessionId).toBe('ses_child_int');

      // B5/B6 fixtures were copied and B6's seed ran through the real CLI
      // against the unit's isolated database.
      expect(
        existsSync(join(runDir, 'scenarios', 'b5', 'mind-v9', 'workspace', 'package.json'))
      ).toBe(true);
      const b6DbPath = join(runDir, 'scenarios', 'b6', 'mind-v9', 'mind.db');
      const b6Db = new Database(b6DbPath, { readonly: true });
      const seededLinks = b6Db.query('SELECT label FROM links').all() as { label: string }[];
      b6Db.close();
      expect(seededLinks.map(link => link.label)).toEqual(['related']);

      // B7's seed ran through the real CLI into the unit's isolated database.
      const b7DbPath = join(runDir, 'scenarios', 'b7', 'mind-v9', 'mind.db');
      const b7Db = new Database(b7DbPath, { readonly: true });
      const b7Seed = b7Db
        .query(
          `SELECT m.name AS name, mt.tag AS tag
             FROM memories m
             JOIN spaces s ON m.space_id = s.id
             LEFT JOIN memory_tags mt ON mt.memory_id = m.id
            WHERE s.name = ? AND m.name = ?`
        )
        .all(B7_SPACE, B7_OLD_NAME) as { name: string; tag: string }[];
      b7Db.close();
      expect(b7Seed.map(row => row.tag)).toContain('cat:decision');

      // B8's seed ran through the real CLI into the unit's isolated database.
      const b8DbPath = join(runDir, 'scenarios', 'b8', 'mind-v9', 'mind.db');
      const b8Db = new Database(b8DbPath, { readonly: true });
      const b8Seed = b8Db
        .query(
          `SELECT m.name AS name, m.tier AS tier, m.pinned AS pinned
             FROM memories m
             JOIN spaces s ON m.space_id = s.id
            WHERE s.name = ?
            ORDER BY m.name`
        )
        .all(B8_SPACE) as { name: string; tier: number; pinned: number }[];
      b8Db.close();
      expect(b8Seed.map(row => row.name)).toEqual([B8_BACKGROUND, B8_CHECKLIST]);
      expect(b8Seed.every(row => row.tier === 2 && row.pinned === 0)).toBe(true);

      // B9 has no seed; its fixture was copied into the workspace.
      expect(
        existsSync(join(runDir, 'scenarios', 'b9', 'mind-v9', 'workspace', 'package.json'))
      ).toBe(true);

      // B10 needs RAG and is gated not_run without an embedding credential:
      // no sessions run and the unit is never failed.
      const b10 = run.results.find(result => result.scenarioId === 'b10');
      expect(b10?.status).toBe('not_run');
      expect(b10?.notRunReason).toContain('OPENROUTER_API_KEY');
      expect(b10?.sessions).toHaveLength(0);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);
});
