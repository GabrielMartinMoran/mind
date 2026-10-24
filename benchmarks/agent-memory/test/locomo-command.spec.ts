// Command-level tests for the free LoCoMo A1 preparation phase. They never
// start a real Mind server or worktree: the dataset fetch is injected to halt
// right after the ensure-worktrees stage, and the command runner is a fake, so
// the only observable side effect is which preparation commands were invoked.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { DEFAULT_CONDITIONS } from '../src/config';
import { checkEmbeddingCoverage, runLocomoCommand } from '../src/locomo/command';
import { createFakeRunner } from '../src/testing/fakes';

const repoRoot = resolve(import.meta.dir, '../../..');

function tempBenchDirs(): { root: string; runsRoot: string; workRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-locomo-cmd-'));
  return { root, runsRoot: join(root, 'runs'), workRoot: join(root, '.work') };
}

function haltAfterPreparation(): never {
  throw new Error('halt-after-preparation');
}

describe('locomo command preparation', () => {
  test('default/current conditions use the checkout and prepare no pinned worktree', async () => {
    const dirs = tempBenchDirs();
    try {
      const { runner, calls } = createFakeRunner();
      const out: string[] = [];
      const err: string[] = [];
      const provenance = {
        branch: 'feat/current',
        headSha: 'abc123def',
        dirty: true,
        packageVersion: '1.6.0',
        schemaVersion: null,
        mindBinary: join(repoRoot, 'mind'),
      };

      const code = await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: DEFAULT_CONDITIONS,
          runId: 'run-current',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
        },
        {
          repoRoot,
          runner,
          stdout: line => out.push(line),
          stderr: line => err.push(line),
          fetchDatasetFn: async () => haltAfterPreparation(),
          provenanceFn: () => provenance,
        }
      );

      expect(code).toBe(1);
      expect(out.join('\n')).toContain('conditions=mind-current');
      expect(err.join('\n')).toContain('halt-after-preparation');
      expect(calls.some(call => call.command === 'git')).toBe(false);
      expect(calls.some(call => call.command === 'bun' && call.args.includes('install'))).toBe(
        false
      );

      const meta = JSON.parse(
        readFileSync(join(dirs.runsRoot, 'run-current', 'meta.json'), 'utf8')
      ) as {
        activeConditions?: string[];
        current?: typeof provenance;
      };
      expect(meta.activeConditions).toEqual(['mind-current']);
      expect(meta.current).toEqual(provenance);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test('an explicit historical condition still prepares its pinned worktree', async () => {
    const dirs = tempBenchDirs();
    try {
      const sha = '36d2f1e'.padEnd(40, '0');
      const { runner, calls } = createFakeRunner(invocation => {
        if (invocation.command === 'git' && invocation.args.includes('rev-parse')) {
          return { stdout: `${sha}\n`, exitCode: 0 };
        }
        return { exitCode: 0 };
      });
      const err: string[] = [];

      const code = await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: ['mind-v9'],
          runId: 'run-v9',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
        },
        {
          repoRoot,
          runner,
          stdout: () => undefined,
          stderr: line => err.push(line),
          fetchDatasetFn: async () => haltAfterPreparation(),
          provenanceFn: () => {
            throw new Error('historical runs must not record current provenance');
          },
        }
      );

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('halt-after-preparation');
      expect(
        calls.some(
          call =>
            call.command === 'git' && call.args.includes('worktree') && call.args.includes('add')
        )
      ).toBe(true);

      const meta = JSON.parse(readFileSync(join(dirs.runsRoot, 'run-v9', 'meta.json'), 'utf8')) as {
        activeConditions?: string[];
        current?: unknown;
        shas: { v9: string | null; v10: string | null };
      };
      expect(meta.activeConditions).toEqual(['mind-v9']);
      expect(meta.current).toBeUndefined();
      expect(meta.shas.v9).toBe(sha);
      expect(meta.shas.v10).toBeNull();
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test('records embeddings as disabled when --rag is absent', async () => {
    const dirs = tempBenchDirs();
    try {
      const { runner } = createFakeRunner();
      await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: DEFAULT_CONDITIONS,
          runId: 'run-off',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
        },
        {
          repoRoot,
          runner,
          stdout: () => undefined,
          stderr: () => undefined,
          fetchDatasetFn: async () => haltAfterPreparation(),
          provenanceFn: () => ({
            branch: null,
            headSha: null,
            dirty: null,
            packageVersion: null,
            schemaVersion: null,
            mindBinary: null,
          }),
        }
      );

      const meta = JSON.parse(
        readFileSync(join(dirs.runsRoot, 'run-off', 'meta.json'), 'utf8')
      ) as { rag?: { enabled: boolean; provider: string | null } };
      expect(meta.rag).toEqual({ enabled: false, provider: null });
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test('records embeddings as enabled with OpenRouter when --rag is passed', async () => {
    const dirs = tempBenchDirs();
    try {
      const { runner } = createFakeRunner();
      await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: DEFAULT_CONDITIONS,
          runId: 'run-on',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
          rag: true,
        },
        {
          repoRoot,
          runner,
          stdout: () => undefined,
          stderr: () => undefined,
          fetchDatasetFn: async () => haltAfterPreparation(),
          credentialEnv: {},
          provenanceFn: () => ({
            branch: null,
            headSha: null,
            dirty: null,
            packageVersion: null,
            schemaVersion: null,
            mindBinary: null,
          }),
        }
      );

      const meta = JSON.parse(readFileSync(join(dirs.runsRoot, 'run-on', 'meta.json'), 'utf8')) as {
        rag?: { enabled: boolean; provider: string | null };
      };
      expect(meta.rag).toEqual({ enabled: true, provider: 'openrouter' });
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});

describe('embedding coverage gate', () => {
  function writeDb(path: string, embeddings: readonly (Uint8Array | null)[]): void {
    const db = new Database(path);
    try {
      db.exec(`
        CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE memories (id TEXT PRIMARY KEY, space_id TEXT, name TEXT, embedding BLOB);
      `);
      db.prepare('INSERT INTO spaces (id, name) VALUES (?, ?)').run('s1', 'locomo/conv-26');
      const insert = db.prepare(
        'INSERT INTO memories (id, space_id, name, embedding) VALUES (?, ?, ?, ?)'
      );
      embeddings.forEach((embedding, index) => {
        insert.run(`m${index}`, 's1', `D${index}:1`, embedding);
      });
    } finally {
      db.close();
    }
  }

  test('passes when every expected memory has an embedding', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-coverage-'));
    try {
      const dbPath = join(root, 'mind.db');
      writeDb(dbPath, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
      const check = checkEmbeddingCoverage(dbPath, 'locomo/conv-26', ['D0:1', 'D1:1']);
      expect(check.ok).toBe(true);
      expect(check.expected).toBe(2);
      expect(check.embedded).toBe(2);
      expect(check.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails and names the missing coverage when one memory lacks an embedding', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-coverage-'));
    try {
      const dbPath = join(root, 'mind.db');
      writeDb(dbPath, [new Uint8Array([1, 2, 3]), null]);
      const check = checkEmbeddingCoverage(dbPath, 'locomo/conv-26', ['D0:1', 'D1:1']);
      expect(check.ok).toBe(false);
      expect(check.expected).toBe(2);
      expect(check.embedded).toBe(1);
      expect(check.missing).toEqual(['D1:1']);
      expect(check.detail).toContain('1/2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A command-level fail-closed test: the whole `runLocomoCommand` pipeline runs
// against a fake runner that materialises a real (partially embedded) fixture
// database, so no Mind process and no embedding provider is ever contacted.
describe('locomo command RAG embedding gate', () => {
  function fixtureDataset(): unknown[] {
    return [
      {
        sample_id: 'conv-26',
        conversation: {
          speaker_a: 'Ada',
          speaker_b: 'Bob',
          session_1_date_time: '10:00 am on 1 Jan, 2024',
          session_1: [
            { speaker: 'Ada', dia_id: 'D1:1', text: 'I adopted a greyhound named Pixel.' },
            { speaker: 'Bob', dia_id: 'D1:2', text: 'Greyhounds are wonderful companions.' },
          ],
        },
        qa: [
          {
            question: 'Which dog did Ada adopt?',
            answer: 'Pixel',
            evidence: ['D1:1'],
            category: 4,
          },
        ],
      },
    ];
  }

  function createPartiallyEmbeddedDbWriter(): {
    runner: ReturnType<typeof createFakeRunner>['runner'];
    calls: ReturnType<typeof createFakeRunner>['calls'];
  } {
    // The first ingested turn gets an embedding; the second stays NULL, which
    // makes the post-ingest coverage gate fail closed.
    let added = 0;
    const { runner, calls } = createFakeRunner(invocation => {
      const dbPath = invocation.env?.MIND_DB_PATH;
      const command = invocation.args[0];
      if (!dbPath) return undefined;

      if (command === 'create') {
        const spaceName = invocation.args[1] ?? '';
        const db = new Database(dbPath);
        try {
          db.exec(`
            CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE memories (id TEXT PRIMARY KEY, space_id TEXT, name TEXT,
                                   embedding BLOB);
          `);
          db.prepare('INSERT INTO spaces (id, name) VALUES (?, ?)').run('s1', spaceName);
        } finally {
          db.close();
        }
        return undefined;
      }

      if (command === 'add') {
        const name = invocation.args[2] ?? '';
        const embedding = added === 0 ? new Uint8Array([1, 2, 3]) : null;
        added += 1;
        const db = new Database(dbPath);
        try {
          db.prepare(
            'INSERT INTO memories (id, space_id, name, embedding) VALUES (?, ?, ?, ?)'
          ).run(`m${added}`, 's1', name, embedding);
        } finally {
          db.close();
        }
      }
      return undefined;
    });
    return { runner, calls };
  }

  test('aborts after ingest on partial coverage and never records an A1 stage', async () => {
    const dirs = tempBenchDirs();
    try {
      const datasetPath = join(dirs.root, 'locomo-fixture.json');
      writeFileSync(datasetPath, JSON.stringify(fixtureDataset()), 'utf8');
      const { runner, calls } = createPartiallyEmbeddedDbWriter();
      const err: string[] = [];

      const code = await runLocomoCommand(
        {
          subset: 'pilot',
          conditions: DEFAULT_CONDITIONS,
          runId: 'run-partial',
          runsRoot: dirs.runsRoot,
          workRoot: dirs.workRoot,
          rag: true,
        },
        {
          repoRoot,
          runner,
          stdout: () => undefined,
          stderr: line => err.push(line),
          fetchDatasetFn: async () => ({
            path: datasetPath,
            sha256: 'fixture-sha256',
            bytes: 0,
            fromCache: false,
            url: 'file://locomo-fixture',
            attribution: 'fixture',
          }),
          credentialEnv: {},
          provenanceFn: () => ({
            branch: null,
            headSha: null,
            dirty: null,
            packageVersion: null,
            schemaVersion: null,
            mindBinary: null,
          }),
        }
      );

      expect(code).toBe(1);

      const meta = JSON.parse(
        readFileSync(join(dirs.runsRoot, 'run-partial', 'meta.json'), 'utf8')
      ) as { stages: Record<string, { status: string; note?: string }> };
      expect(meta.stages['mind-current:ingest']?.status).toBe('passed');
      expect(meta.stages['mind-current:embeddings']?.status).toBe('failed');
      expect(meta.stages['mind-current:embeddings']?.note).toContain('1/2');
      expect(meta.stages['mind-current:a1']).toBeUndefined();
      expect(err.join('\n')).toContain('embeddings incomplete');
      expect(
        existsSync(join(dirs.runsRoot, 'run-partial', 'results', 'mind-current-a1.json'))
      ).toBe(false);
      expect(calls.some(call => call.args[0] === 'search')).toBe(false);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
