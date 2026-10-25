// Unit tests for benchmark B: scenario assertions, registry shape, the runner
// lifecycle with a fake driver, and the dry-run wiring. No network, no LLM.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
  runScenarioRun,
  scenarioGateReason,
  type BSessionExecutor,
  type BSessionJob,
  type InitMindDbInput,
  type PrepareUnit,
  type ScenariosRunResult,
} from '../src/benchmarkB/runner';
import type { SearchProvenanceResult } from '../src/benchmarkB/runner';
import type {
  BChildResult,
  BSessionOutcome,
  BSessionResult,
  Scenario,
  ScenarioAssertionContext,
} from '../src/benchmarkB/scenario';
import {
  ISO_UTC_PATTERN,
  makeAssertion as b1MakeAssertion,
} from '../src/benchmarkB/scenarios/b1/index';
import {
  B10_ARTIFACT_FILE,
  B10_DISTRACTOR,
  B10_DISTRACTOR_CONTENT,
  B10_PROMPTS,
  B10_SCENARIO,
  B10_SPACE,
  B10_TARGET,
  B10_TARGET_CONTENT,
  makeAssertion as b10MakeAssertion,
} from '../src/benchmarkB/scenarios/b10/index';
import { B11_PROMPTS, B11_SCENARIO } from '../src/benchmarkB/scenarios/b11/index';
import {
  B4_FIXTURE_TEST_FILE,
  B4_SCENARIO,
  B4_WORKSPACE_TEST_FILE,
  makeAssertion as b4MakeAssertion,
} from '../src/benchmarkB/scenarios/b4/index';
import {
  B5_APPLIED_FILE,
  B5_PROMPTS,
  B5_SCENARIO,
  makeAssertion as b5MakeAssertion,
} from '../src/benchmarkB/scenarios/b5/index';
import {
  B6_ANSWER_FILE,
  B6_IMPLEMENTATION,
  B6_INTENDED_LABEL,
  B6_PROMPTS,
  B6_SCENARIO,
  B6_STALE_LABEL,
  B6_STRATEGY,
  makeAssertion as b6MakeAssertion,
} from '../src/benchmarkB/scenarios/b6/index';
import {
  B7_ARTIFACT_FILE,
  B7_LINK_LABEL,
  B7_NEW_PATH,
  B7_OLD_CATEGORY_TAG,
  B7_OLD_CONTENT,
  B7_OLD_NAME,
  B7_PROMPTS,
  B7_SCENARIO,
  B7_SPACE,
  makeAssertion as b7MakeAssertion,
} from '../src/benchmarkB/scenarios/b7/index';
import {
  B8_ARTIFACT_FILE,
  B8_BACKGROUND,
  B8_BACKGROUND_TAG,
  B8_CHECKLIST,
  B8_CHECKLIST_TAG,
  B8_PROMPTS,
  B8_SCENARIO,
  B8_SPACE,
  makeAssertion as b8MakeAssertion,
} from '../src/benchmarkB/scenarios/b8/index';
import {
  B9_ARTIFACT_FILE,
  B9_FACT_VERSION,
  B9_PROMPTS,
  B9_SCENARIO,
  makeAssertion as b9MakeAssertion,
} from '../src/benchmarkB/scenarios/b9/index';
import { SCENARIOS, SCENARIO_IDS, selectScenarios } from '../src/benchmarkB/scenarios/registry';
import { BudgetExceededError, BudgetGuard } from '../src/budget';
import type { ConditionId } from '../src/config';
import type { CommandRunner } from '../src/exec';
import { inspectEmbeddingCoverage } from '../src/mind/inspect';
import {
  buildDriverEvidence,
  type DriverEvidence,
  type DriverToolCall,
} from '../src/opencode/driver';
import { createFakeSessionDriver, type FakeSessionScript } from '../src/testing/fakes';

const HARNESS_ROOT = join(import.meta.dir, '..');

function fixtureDirFor(scenario: { fixture: string }): string {
  return join(HARNESS_ROOT, scenario.fixture);
}

function okRunner(exitCode = 0): CommandRunner {
  return async invocation => ({
    command: invocation.command,
    args: invocation.args,
    stdout: '',
    stderr: exitCode === 0 ? '' : 'boom',
    exitCode,
  });
}

function ctx(
  workspaceDir: string,
  overrides: Partial<ScenarioAssertionContext> = {}
): ScenarioAssertionContext {
  return {
    workspaceDir,
    sessionResults: [],
    childResults: [],
    mindDb: null,
    run: okRunner(),
    ...overrides,
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function b1PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b1-pass-'));
  write(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  write(
    join(dir, 'data', 'tasks.json'),
    JSON.stringify({ exportedAt: '2026-10-18T00:00:00.000Z', tasks: [] })
  );
  return dir;
}

function child(memoryCalls: number): BChildResult {
  return {
    sessionId: 'ses_child',
    finalText: '',
    memoryCalls,
    toolCalls: memoryCalls,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 1,
    finish: 'stop',
    error: null,
  };
}

function toolCall(name: string): DriverToolCall {
  return { id: `tool_${name}`, name, server: null };
}

/**
 * A B session that carries the runtime evidence Contract 1 added. The shared
 * `BSessionOutcome` type is owned by `scenario.ts`, so the extra field is
 * modelled locally here.
 */
function sessionWithEvidence(
  toolNames: readonly string[] = [],
  childSessionIds: readonly string[] | null = []
): BSessionResult & { evidence: DriverEvidence } {
  return {
    status: 'ok',
    sessionId: 'ses_parent',
    finalText: '',
    toolCalls: toolNames.map(toolCall),
    memoryCalls: 0,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 1,
    finish: 'stop',
    error: null,
    errorType: null,
    isolationOk: true,
    children: [],
    rawMessages: { data: [] },
    sessionIndex: 0,
    prompt: 'prompt',
    evidence: buildDriverEvidence({
      sessionId: 'ses_parent',
      messages: [],
      childSessionIds,
      idleOutcome: 'succeeded',
    }),
  };
}

describe('scenario registry', () => {
  test('exposes b1, b4, b5, b6, b7, b9, b8, b10 and b11 with identical prompts and assertions', () => {
    expect(SCENARIO_IDS).toEqual(['b1', 'b4', 'b5', 'b6', 'b7', 'b9', 'b8', 'b10', 'b11']);
    expect(SCENARIOS).toHaveLength(9);
    for (const scenario of SCENARIOS) {
      const expectedSessions = scenario.id === 'b9' ? 3 : scenario.id === 'b10' ? 1 : 2;
      expect(scenario.sessions).toHaveLength(expectedSessions);
      expect(typeof scenario.makeAssertion).toBe('function');
      expect(scenario.fixture).toMatch(/^fixtures\//);
    }
  });

  test('selectScenarios preserves registry order and rejects unknown ids', () => {
    expect(selectScenarios(['b4']).map(s => s.id)).toEqual(['b4']);
    expect(selectScenarios(['b6']).map(s => s.id)).toEqual(['b6']);
    expect(selectScenarios(['b9']).map(s => s.id)).toEqual(['b9']);
    expect(selectScenarios(['b8']).map(s => s.id)).toEqual(['b8']);
    expect(selectScenarios(['b10']).map(s => s.id)).toEqual(['b10']);
    expect(selectScenarios(['b11']).map(s => s.id)).toEqual(['b11']);
    expect(selectScenarios().map(s => s.id)).toEqual([
      'b1',
      'b4',
      'b5',
      'b6',
      'b7',
      'b9',
      'b8',
      'b10',
      'b11',
    ]);
    expect(() => selectScenarios(['nope'])).toThrow('unknown scenario');
  });
});

describe('B1 assertion', () => {
  test('passes a workspace with no deps, file persistence and UTC timestamps', async () => {
    const result = await b1MakeAssertion(ctx(b1PassWorkspace()));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('no dependencies added');
    expect(result.details.join('\n')).toContain('UTC ISO-8601');
  });

  test('fails when a dependency was added', async () => {
    const dir = b1PassWorkspace();
    write(join(dir, 'package.json'), JSON.stringify({ dependencies: { better: '^1' } }));
    const result = await b1MakeAssertion(ctx(dir));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('new dependencies added');
  });

  test('fails when no persistence file exists under data/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b1-nodata-'));
    write(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    const result = await b1MakeAssertion(ctx(dir));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no JSON/JSONL persistence file');
  });

  test('fails when a timestamp is not UTC ISO-8601', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b1-badts-'));
    write(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    write(
      join(dir, 'data', 'tasks.json'),
      JSON.stringify({ exportedAt: '2026-10-18T00:00:00.000+02:00', tasks: [] })
    );
    const result = await b1MakeAssertion(ctx(dir));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('non-UTC-ISO timestamp');
  });

  test('fails when the export command does not run', async () => {
    const result = await b1MakeAssertion(ctx(b1PassWorkspace(), { run: okRunner(1) }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('export command failed');
  });

  test('accepts JSONL persistence and parses timestamps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b1-jsonl-'));
    write(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    write(
      join(dir, 'data', 'tasks.jsonl'),
      '{"id":"1","createdAt":"2026-10-18T12:34:56Z"}\n{"id":"2","createdAt":"2026-10-18T12:35:00.500Z"}\n'
    );
    const result = await b1MakeAssertion(ctx(dir));
    expect(result.pass).toBe(true);
  });

  test('collectTimestamps finds ISO-like strings and the pattern accepts Z', () => {
    expect(ISO_UTC_PATTERN.test('2026-10-18T00:00:00.000Z')).toBe(true);
    expect(ISO_UTC_PATTERN.test('2026-10-18T00:00:00+00:00')).toBe(true);
    expect(ISO_UTC_PATTERN.test('2026-10-18 00:00:00')).toBe(false);
  });
});

describe('B4 assertion', () => {
  test('passes when the test suite passes and a child session exists', async () => {
    const result = await b4MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b4-pass-')), {
        childResults: [child(0)],
        sessionResults: [sessionWithEvidence(['subagent'], ['ses_child'])],
      })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('1 child session(s) captured');
    expect(result.details.join('\n')).toContain('child used memory tools: no');
  });

  test('fails when the test suite still fails', async () => {
    const result = await b4MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b4-fail-')), {
        childResults: [child(2)],
        sessionResults: [sessionWithEvidence(['subagent'], ['ses_child'])],
        run: okRunner(1),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('test suite failed');
  });

  test('fails when no child session was created after a successful capture', async () => {
    const result = await b4MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b4-nochild-')), {
        sessionResults: [sessionWithEvidence(['subagent'], [])],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no child (sub-agent) session');
  });

  test('Unavailable child evidence is not reported as no child behavior', async () => {
    const result = await b4MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b4-harness-')), {
        sessionResults: [sessionWithEvidence(['subagent'], null)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('harness error');
    expect(details).toContain('child evidence unavailable after a recorded subagent call');
    expect(details).not.toContain('no child (sub-agent) session');
  });

  test('reports a harness error instead of no child when no session evidence exists', async () => {
    const result = await b4MakeAssertion(ctx(mkdtempSync(join(tmpdir(), 'bench-b4-noev-'))));
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('harness error');
    expect(details).not.toContain('no child (sub-agent) session');
  });

  test('reports child memory use as measured, not required', async () => {
    const result = await b4MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b4-mem-')), {
        childResults: [child(3)],
        sessionResults: [sessionWithEvidence(['subagent'], ['ses_child'])],
      })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('child used memory tools: yes');
  });
});

describe('B4 fixture hygiene', () => {
  test('ships the failing test under a non-test-discoverable name', () => {
    expect(B4_FIXTURE_TEST_FILE).not.toMatch(/\.(test|spec)\./);
    expect(B4_FIXTURE_TEST_FILE).not.toMatch(/_(test|spec)\./);
    // Only the renamed fixture exists; the old `range.test.ts` is gone.
    expect(existsSync(join(HARNESS_ROOT, B4_SCENARIO.fixture, B4_FIXTURE_TEST_FILE))).toBe(true);
    expect(existsSync(join(HARNESS_ROOT, B4_SCENARIO.fixture, B4_WORKSPACE_TEST_FILE))).toBe(false);
  });

  test('prepare renames the fixture into range.test.ts inside the workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bench-b4-prep-'));
    cpSync(fixtureDirFor(B4_SCENARIO), workspace, { recursive: true });
    expect(existsSync(join(workspace, B4_FIXTURE_TEST_FILE))).toBe(true);
    B4_SCENARIO.prepare!({ workspaceDir: workspace });
    expect(existsSync(join(workspace, B4_WORKSPACE_TEST_FILE))).toBe(true);
    expect(existsSync(join(workspace, B4_FIXTURE_TEST_FILE))).toBe(false);
  });

  test('prepare is a no-op when the injected copy left no fixture files', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bench-b4-prep-empty-'));
    expect(() => B4_SCENARIO.prepare!({ workspaceDir: workspace })).not.toThrow();
  });

  test('the runner runs prepare end-to-end through a real fixture copy', async () => {
    const seen: string[] = [];
    const { run } = await runHarness(['no-memory'], { onJob: () => seen.push('job') });
    const b4 = run.results.find(r => r.scenarioId === 'b4')!;
    // The scenario executed both sessions against the prepared workspace.
    expect(b4.sessions).toHaveLength(2);
    expect(seen.length).toBeGreaterThan(0);
  });
});

// ── B5 / B6 DB assertions ────────────────────────────────────────────────────

interface SeedMemoryRow {
  readonly id: string;
  readonly space: string;
  readonly name: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly tier?: 1 | 2 | 3;
  readonly pinned?: boolean;
  /** Embedding bytes when the synthetic row simulates a RAG-indexed memory. */
  readonly embedding?: Uint8Array | null;
}

interface SeedLinkRow {
  readonly source: string;
  readonly target: string;
  readonly label: string;
}

/** Minimal schema-shaped DB (no UNIQUE name constraint so duplicates are testable). */
function createScenarioDb(
  memories: readonly SeedMemoryRow[],
  links: readonly SeedLinkRow[] = []
): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-scenario-db-'));
  const path = join(dir, 'mind.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      name TEXT,
      content TEXT,
      tier INTEGER,
      pinned INTEGER,
      changed_at TEXT,
      embedding BLOB
    );
    CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
    CREATE TABLE links (
      source_id TEXT,
      target_id TEXT,
      label TEXT,
      created_at TEXT
    );
  `);
  const spaceIds = new Map<string, string>();
  const insertSpace = db.query('INSERT INTO spaces (id, name) VALUES (?, ?)');
  const insertMemory = db.query(
    'INSERT INTO memories (id, space_id, name, content, tier, pinned, changed_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertTag = db.query('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)');
  for (const memory of memories) {
    let spaceId = spaceIds.get(memory.space);
    if (!spaceId) {
      spaceId = `space-${spaceIds.size + 1}`;
      spaceIds.set(memory.space, spaceId);
      insertSpace.run(spaceId, memory.space);
    }
    insertMemory.run(
      memory.id,
      spaceId,
      memory.name,
      memory.content,
      memory.tier ?? 2,
      memory.pinned ? 1 : 0,
      '2026-10-19T00:00:00Z',
      memory.embedding ?? null
    );
    for (const tag of memory.tags) insertTag.run(memory.id, tag);
  }
  const idByName = new Map(memories.map(memory => [memory.name, memory.id]));
  const insertLink = db.query(
    'INSERT INTO links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const link of links) {
    insertLink.run(
      idByName.get(link.source)!,
      idByName.get(link.target)!,
      link.label,
      '2026-10-19T00:00:00Z'
    );
  }
  db.close();
  return path;
}

function b5Memory(overrides: Partial<SeedMemoryRow> = {}): SeedMemoryRow {
  return {
    id: 'm1',
    space: 'projects/demo',
    name: 'task-persistence-decision',
    content: 'Persist tasks as JSON Lines in storage/tasks.jsonl with UTC ISO-8601 timestamps.',
    tags: ['cat:decision'],
    ...overrides,
  };
}

function b5PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b5-ws-'));
  write(
    join(dir, B5_APPLIED_FILE),
    'Applied JSON Lines persistence to storage/tasks.jsonl with UTC ISO-8601 timestamps.\n'
  );
  return dir;
}

describe('B5 durable writing assertion', () => {
  test('passes with a category-tagged project memory containing the decided terms', async () => {
    const dbPath = createScenarioDb([b5Memory()]);
    const result = await b5MakeAssertion(ctx(b5PassWorkspace(), { mindDb: dbPath }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('durable decision/pattern memory');
  });

  test('fails when no project memory carries a decision/pattern category tag', async () => {
    const dbPath = createScenarioDb([b5Memory({ tags: ['type:decision'] })]);
    const result = await b5MakeAssertion(ctx(b5PassWorkspace(), { mindDb: dbPath }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no project memory');
  });

  test('fails when the stored content omits the decision key terms', async () => {
    const dbPath = createScenarioDb([b5Memory({ content: 'Use a database.' })]);
    const result = await b5MakeAssertion(ctx(b5PassWorkspace(), { mindDb: dbPath }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('key terms');
  });

  test('fails when the same memory name is stored twice', async () => {
    const dbPath = createScenarioDb([b5Memory(), b5Memory({ id: 'm2' })]);
    const result = await b5MakeAssertion(ctx(b5PassWorkspace(), { mindDb: dbPath }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('duplicate memory name');
  });

  test('fails when the later-session artifact is missing', async () => {
    const dbPath = createScenarioDb([b5Memory()]);
    const result = await b5MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b5-noapplied-')), { mindDb: dbPath })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B5_APPLIED_FILE} was not written`);
  });

  test('fails when the later-session artifact does not reflect the decision', async () => {
    const dbPath = createScenarioDb([b5Memory()]);
    const workspace = mkdtempSync(join(tmpdir(), 'bench-b5-badapplied-'));
    write(join(workspace, B5_APPLIED_FILE), 'Used a single SQLite table instead.\n');
    const result = await b5MakeAssertion(ctx(workspace, { mindDb: dbPath }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('does not name');
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b5MakeAssertion(ctx(b5PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

function b6Db(label: string, overrides: Partial<SeedLinkRow> = {}): string {
  return createScenarioDb(
    [
      {
        id: 'm1',
        space: 'projects/b6-app',
        name: B6_STRATEGY,
        content: 'Checkout uses a two-step authorize-then-capture flow.',
        tags: ['cat:decision'],
      },
      {
        id: 'm2',
        space: 'projects/b6-app',
        name: B6_IMPLEMENTATION,
        content: 'The checkout implementation lives in src/checkout.ts.',
        tags: ['cat:pattern'],
      },
    ],
    [
      {
        source: B6_IMPLEMENTATION,
        target: B6_STRATEGY,
        label,
        ...overrides,
      },
    ]
  );
}

function b6PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b6-'));
  write(join(dir, B6_ANSWER_FILE), `${B6_STRATEGY}\n`);
  return dir;
}

describe('B6 relinking assertion', () => {
  test('passes with the intended direction/label and the answer artifact', async () => {
    const result = await b6MakeAssertion(
      ctx(b6PassWorkspace(), { mindDb: b6Db(B6_INTENDED_LABEL) })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain(
      `${B6_IMPLEMENTATION} → ${B6_STRATEGY} [${B6_INTENDED_LABEL}]`
    );
  });

  test('fails when the intended link is missing', async () => {
    const dbPath = createScenarioDb([]);
    const result = await b6MakeAssertion(ctx(b6PassWorkspace(), { mindDb: dbPath }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('expected link');
  });

  test('fails when the old related label is still present', async () => {
    const result = await b6MakeAssertion(ctx(b6PassWorkspace(), { mindDb: b6Db(B6_STALE_LABEL) }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('expected link');
  });

  test('fails when the link direction is reversed', async () => {
    const result = await b6MakeAssertion(
      ctx(b6PassWorkspace(), {
        mindDb: b6Db(B6_INTENDED_LABEL, { source: B6_STRATEGY, target: B6_IMPLEMENTATION }),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('wrong direction');
  });

  test('fails when the answer artifact is missing', async () => {
    const result = await b6MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b6-noanswer-')), {
        mindDb: b6Db(B6_INTENDED_LABEL),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('answer.txt');
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b6MakeAssertion(ctx(b6PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

// ── B7 / B9 DB assertions ────────────────────────────────────────────────────

const B7_NEW_NAME = 'task-storage-jsonl-decision';
const B7_NEW_CONTENT =
  'Tasks are persisted as JSON Lines in storage/tasks.jsonl with UTC ISO-8601 timestamps.';

interface B7DbOptions {
  readonly oldPresent?: boolean;
  readonly oldTags?: readonly string[];
  readonly oldContent?: string;
  readonly newPresent?: boolean;
  readonly newContent?: string;
  readonly newTags?: readonly string[];
  /** `null` omits the link entirely. */
  readonly linkLabel?: string | null;
  readonly reverseLink?: boolean;
  readonly duplicateNew?: boolean;
}

function b7Db(options: B7DbOptions = {}): string {
  const memories: SeedMemoryRow[] = [];
  if (options.oldPresent !== false) {
    memories.push({
      id: 'm-old',
      space: B7_SPACE,
      name: B7_OLD_NAME,
      content: options.oldContent ?? B7_OLD_CONTENT,
      tags: options.oldTags ?? [B7_OLD_CATEGORY_TAG, 'status:superseded'],
    });
  }
  if (options.newPresent !== false) {
    memories.push({
      id: 'm-new',
      space: B7_SPACE,
      name: B7_NEW_NAME,
      content: options.newContent ?? B7_NEW_CONTENT,
      tags: options.newTags ?? ['cat:decision'],
    });
    if (options.duplicateNew) {
      memories.push({
        id: 'm-new-copy',
        space: B7_SPACE,
        name: B7_NEW_NAME,
        content: options.newContent ?? B7_NEW_CONTENT,
        tags: options.newTags ?? ['cat:decision'],
      });
    }
  }

  const linkLabel = options.linkLabel === undefined ? B7_LINK_LABEL : options.linkLabel;
  const links: SeedLinkRow[] =
    linkLabel === null
      ? []
      : [
          {
            source: options.reverseLink ? B7_OLD_NAME : B7_NEW_NAME,
            target: options.reverseLink ? B7_NEW_NAME : B7_OLD_NAME,
            label: linkLabel,
          },
        ];

  return createScenarioDb(memories, links);
}

function b7PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b7-'));
  write(join(dir, B7_ARTIFACT_FILE), `JSON Lines in ${B7_NEW_PATH} with UTC timestamps.\n`);
  return dir;
}

describe('B7 decision change / supersession assertion', () => {
  test('passes with the preserved historical memory, replacement, link and artifact', async () => {
    const result = await b7MakeAssertion(ctx(b7PassWorkspace(), { mindDb: b7Db() }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain(`historical memory marked 'status:superseded'`);
    expect(result.details.join('\n')).toContain(
      `${B7_NEW_NAME} → ${B7_OLD_NAME} [${B7_LINK_LABEL}]`
    );
  });

  test('fails when the historical memory lost its superseded marker', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ oldTags: [B7_OLD_CATEGORY_TAG] }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`not marked 'status:superseded'`);
  });

  test('fails when the historical memory lost its category tag', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ oldTags: ['status:superseded'] }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`lost its '${B7_OLD_CATEGORY_TAG}' tag`);
  });

  test('fails when the historical memory uses status:obsolete instead of status:superseded', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), {
        mindDb: b7Db({ oldTags: [B7_OLD_CATEGORY_TAG, 'status:obsolete'] }),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`not marked 'status:superseded'`);
  });

  test('fails when the historical memory content was overwritten', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ oldContent: B7_NEW_CONTENT }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('content was overwritten');
  });

  test('fails when the historical memory is gone', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ oldPresent: false, linkLabel: null }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`historical decision memory '${B7_OLD_NAME}'`);
  });

  test('fails when no new memory records the replacement decision', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ newPresent: false, linkLabel: null }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no new category-tagged memory');
  });

  test('fails when the new memory lacks a category tag', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ newTags: ['type:decision'] }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no new category-tagged memory');
  });

  test('fails when the link direction is reversed', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ reverseLink: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('wrong direction');
  });

  test('fails when the link uses the wrong label', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ linkLabel: 'related' }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`expected '${B7_LINK_LABEL}'`);
  });

  test('fails when the link is missing', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ linkLabel: null }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('expected link missing');
  });

  test('fails when the replacement name is stored twice', async () => {
    const result = await b7MakeAssertion(
      ctx(b7PassWorkspace(), { mindDb: b7Db({ duplicateNew: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('duplicate memory name');
  });

  test('fails when the later-session artifact is missing', async () => {
    const result = await b7MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b7-noartifact-')), { mindDb: b7Db() })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B7_ARTIFACT_FILE} was not written`);
  });

  test('fails when the artifact does not name the new decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b7-badartifact-'));
    write(join(dir, B7_ARTIFACT_FILE), 'Still stored in SQLite.\n');
    const result = await b7MakeAssertion(ctx(dir, { mindDb: b7Db() }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`does not name ${B7_NEW_PATH}`);
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b7MakeAssertion(ctx(b7PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

// ── B8 tier maintenance ──────────────────────────────────────────────────────

interface B8DbOptions {
  readonly checklistPresent?: boolean;
  readonly checklistTier?: 1 | 2 | 3;
  readonly checklistPinned?: boolean;
  readonly backgroundPresent?: boolean;
  readonly backgroundTier?: 1 | 2 | 3;
  readonly backgroundPinned?: boolean;
  readonly duplicateChecklist?: boolean;
}

function b8Db(options: B8DbOptions = {}): string {
  const memories: SeedMemoryRow[] = [];
  if (options.checklistPresent !== false) {
    memories.push({
      id: 'm-checklist',
      space: B8_SPACE,
      name: B8_CHECKLIST,
      content: 'Release checklist: 1) run bun test; 2) run bun run build.',
      tags: [B8_CHECKLIST_TAG],
      tier: options.checklistTier ?? 1,
      pinned: options.checklistPinned ?? true,
    });
    if (options.duplicateChecklist) {
      memories.push({
        id: 'm-checklist-copy',
        space: B8_SPACE,
        name: B8_CHECKLIST,
        content: 'Duplicate release checklist.',
        tags: [B8_CHECKLIST_TAG],
        tier: options.checklistTier ?? 1,
        pinned: options.checklistPinned ?? true,
      });
    }
  }
  if (options.backgroundPresent !== false) {
    memories.push({
      id: 'm-background',
      space: B8_SPACE,
      name: B8_BACKGROUND,
      content: 'Background notes: early prototypes used a shell script.',
      tags: [B8_BACKGROUND_TAG],
      tier: options.backgroundTier ?? 2,
      pinned: options.backgroundPinned ?? false,
    });
  }
  return createScenarioDb(memories);
}

function b8PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b8-'));
  write(join(dir, B8_ARTIFACT_FILE), `${B8_CHECKLIST}: bun test\n`);
  return dir;
}

describe('B8 tier maintenance assertion', () => {
  test('passes when the checklist is pinned at T1 and the background notes stay T2', async () => {
    const result = await b8MakeAssertion(ctx(b8PassWorkspace(), { mindDb: b8Db() }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('release checklist is pinned');
    expect(result.details.join('\n')).toContain('background notes remain at tier 2');
  });

  test('fails when the checklist was not promoted to the active tier', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ checklistTier: 2 }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('release checklist is at tier 2');
  });

  test('fails when the checklist was not pinned', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ checklistPinned: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('release checklist is not pinned');
  });

  test('fails when the background notes were promoted', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ backgroundTier: 1 }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('background notes were promoted to tier 1');
  });

  test('fails when the background notes were pinned', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ backgroundPinned: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('background notes are pinned');
  });

  test('fails when the checklist memory is missing', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ checklistPresent: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`release checklist memory '${B8_CHECKLIST}'`);
  });

  test('fails when the background notes memory is missing', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ backgroundPresent: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`background notes memory '${B8_BACKGROUND}'`);
  });

  test('fails when a project memory name is stored twice', async () => {
    const result = await b8MakeAssertion(
      ctx(b8PassWorkspace(), { mindDb: b8Db({ duplicateChecklist: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('duplicate memory name');
  });

  test('fails when the later-session artifact is missing', async () => {
    const result = await b8MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b8-noartifact-')), { mindDb: b8Db() })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B8_ARTIFACT_FILE} was not written`);
  });

  test('fails when the artifact does not name the checklist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b8-badartifact-'));
    write(join(dir, B8_ARTIFACT_FILE), 'run bun test\n');
    const result = await b8MakeAssertion(ctx(dir, { mindDb: b8Db() }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`does not name ${B8_CHECKLIST}`);
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b8MakeAssertion(ctx(b8PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

// ── B9 cross-session continuity ──────────────────────────────────────────────

interface B9ExtraSummary {
  readonly name: string;
  readonly content: string;
  readonly tier: 1 | 2 | 3;
}

interface B9DbOptions {
  readonly summaryPresent?: boolean;
  readonly summaryTier?: 1 | 2 | 3;
  readonly summaryTags?: readonly string[];
  readonly summaryContent?: string;
  readonly duplicateSummary?: boolean;
  readonly extraSummaries?: readonly B9ExtraSummary[];
}

const B9_SUMMARY_NAME = 'session-2026-10-19-a';
const B9_SPACE = 'projects/b9-app';

function b9Db(options: B9DbOptions = {}): string {
  const memories: SeedMemoryRow[] = [
    {
      id: 'm-fact',
      space: B9_SPACE,
      name: 'minimum-bun-version',
      content: `The minimum supported Bun version is ${B9_FACT_VERSION}.`,
      tags: ['cat:decision'],
    },
  ];
  if (options.summaryPresent !== false) {
    memories.push({
      id: 'm-summary',
      space: B9_SPACE,
      name: B9_SUMMARY_NAME,
      content:
        options.summaryContent ??
        `Session summary: established that the minimum Bun version is ${B9_FACT_VERSION}.`,
      tags: options.summaryTags ?? ['type:session', 'cat:summary'],
      tier: options.summaryTier ?? 3,
    });
    if (options.duplicateSummary) {
      memories.push({
        id: 'm-summary-copy',
        space: B9_SPACE,
        name: B9_SUMMARY_NAME,
        content: 'Duplicate session summary.',
        tags: options.summaryTags ?? ['type:session', 'cat:summary'],
        tier: options.summaryTier ?? 3,
      });
    }
  }
  for (const [index, extra] of (options.extraSummaries ?? []).entries()) {
    memories.push({
      id: `m-summary-extra-${index}`,
      space: B9_SPACE,
      name: extra.name,
      content: extra.content,
      tags: ['type:session', 'cat:summary'],
      tier: extra.tier,
    });
  }
  return createScenarioDb(memories);
}

function b9PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b9-'));
  write(join(dir, B9_ARTIFACT_FILE), `Bun ${B9_FACT_VERSION}\n`);
  return dir;
}

describe('B9 cross-session continuity assertion', () => {
  test('passes with a T3 session summary and an artifact that carries the fact', async () => {
    const result = await b9MakeAssertion(ctx(b9PassWorkspace(), { mindDb: b9Db() }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('fact-bearing session summary found');
    expect(result.details.join('\n')).toContain(`${B9_ARTIFACT_FILE} carries the preserved fact`);
  });

  test('passes when recovery auto-promoted the summary to T1', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), { mindDb: b9Db({ summaryTier: 1 }) })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('(T1)');
  });

  test('passes when the artifact contains only the version fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b9-versiononly-'));
    write(join(dir, B9_ARTIFACT_FILE), `${B9_FACT_VERSION}\n`);
    const result = await b9MakeAssertion(ctx(dir, { mindDb: b9Db() }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain(`${B9_ARTIFACT_FILE} carries the preserved fact`);
  });

  test('passes when recovery auto-promoted the summary to T2', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), { mindDb: b9Db({ summaryTier: 2 }) })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('(T2)');
  });

  test('fails when no session summary exists', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), { mindDb: b9Db({ summaryPresent: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no session summary memory');
  });

  test('fails when the summary tags are incomplete', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), { mindDb: b9Db({ summaryTags: ['type:session'] }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no session summary memory');
  });

  test('fails when the persisted summary does not contain the fact', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), {
        mindDb: b9Db({ summaryContent: 'Session summary: discussed build tooling.' }),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no session summary contains');
  });

  test('passes when only the post-promotion T2 summary carries the fact', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), {
        mindDb: b9Db({
          summaryContent: 'Session summary: discussed build tooling.',
          extraSummaries: [
            {
              name: 'session-2026-10-19-b',
              content: `Session summary: minimum Bun version is ${B9_FACT_VERSION}.`,
              tier: 2,
            },
          ],
        }),
      })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('session-2026-10-19-b (T2)');
  });

  test('fails when the same session summary name is stored twice', async () => {
    const result = await b9MakeAssertion(
      ctx(b9PassWorkspace(), { mindDb: b9Db({ duplicateSummary: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('duplicate session summary name');
  });

  test('fails when the continuity artifact is missing', async () => {
    const result = await b9MakeAssertion(
      ctx(mkdtempSync(join(tmpdir(), 'bench-b9-noartifact-')), { mindDb: b9Db() })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B9_ARTIFACT_FILE} was not written`);
  });

  test('fails when the artifact does not carry the fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b9-badartifact-'));
    write(join(dir, B9_ARTIFACT_FILE), 'Bun is required.\n');
    const result = await b9MakeAssertion(ctx(dir, { mindDb: b9Db() }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`does not contain the Bun ${B9_FACT_VERSION} fact`);
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b9MakeAssertion(ctx(b9PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });

  test('the fixture does not leak the fact (it must come from session memory)', () => {
    const root = fixtureDirFor(B9_SCENARIO);
    for (const relative of ['README.md', 'package.json', 'src/build.ts']) {
      const content = readFileSync(join(root, relative), 'utf8');
      expect(content).not.toMatch(new RegExp(`\\b${B9_FACT_VERSION.replace('.', '\\.')}\\b`));
    }
  });
});

// ── B10 semantic recall ──────────────────────────────────────────────────────

const B10_EMBEDDING = new Uint8Array([0, 0, 128, 63]);

interface B10DbOptions {
  readonly targetPresent?: boolean;
  readonly targetEmbedding?: boolean;
  readonly targetContent?: string;
  readonly distractorPresent?: boolean;
  readonly duplicateTarget?: boolean;
}

function b10Db(options: B10DbOptions = {}): string {
  const memories: SeedMemoryRow[] = [];
  if (options.targetPresent !== false) {
    const target: SeedMemoryRow = {
      id: 'm-b10-target',
      space: B10_SPACE,
      name: B10_TARGET,
      content: options.targetContent ?? B10_TARGET_CONTENT,
      tags: ['cat:decision'],
      embedding: options.targetEmbedding === false ? null : B10_EMBEDDING,
    };
    memories.push(target);
    if (options.duplicateTarget) {
      memories.push({ ...target, id: 'm-b10-target-copy' });
    }
  }
  if (options.distractorPresent !== false) {
    memories.push({
      id: 'm-b10-distractor',
      space: B10_SPACE,
      name: B10_DISTRACTOR,
      content: B10_DISTRACTOR_CONTENT,
      tags: ['cat:pattern'],
      embedding: B10_EMBEDDING,
    });
  }
  return createScenarioDb(memories);
}

function b10PassWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b10-'));
  write(join(dir, B10_ARTIFACT_FILE), 'Release credentials are renewed every 24 hours.\n');
  return dir;
}

/**
 * A recorded `memory_query` provenance entry. B10 must pass on this recorded
 * semantic evidence, never on embedding presence plus answer text alone.
 */
function b10SessionWithProvenance(
  results: readonly SearchProvenanceResult[]
): BSessionResult & { searchProvenance: readonly SearchProvenanceResult[] } {
  return {
    status: 'ok',
    sessionId: 'ses_b10',
    finalText: '',
    toolCalls: [toolCall('mind_memory_query')],
    memoryCalls: 1,
    model: null,
    tokens: null,
    costUsd: 0,
    latencyMs: 0,
    steps: 1,
    finish: 'stop',
    error: null,
    errorType: null,
    isolationOk: true,
    children: [],
    rawMessages: { data: [] },
    sessionIndex: 0,
    prompt: B10_PROMPTS[0]!,
    searchProvenance: results,
  };
}

const B10_SEMANTIC_PROVENANCE: readonly SearchProvenanceResult[] = [
  { name: B10_DISTRACTOR, methods: ['all'] },
  { name: B10_TARGET, methods: ['all', 'semantic'] },
];

function b10Ctx(
  workspaceDir: string,
  overrides: Partial<ScenarioAssertionContext> = {}
): ScenarioAssertionContext {
  return ctx(workspaceDir, {
    sessionResults: [b10SessionWithProvenance(B10_SEMANTIC_PROVENANCE)],
    ...overrides,
  });
}

/** Content words, folded and stripped of the prompt's common scaffolding. */
const PROMPT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'current',
  'directory',
  'do',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'write',
  'you',
  'your',
]);

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    token => !PROMPT_STOPWORDS.has(token)
  );
}

describe('B10 semantic recall assertion', () => {
  test('passes with an embedded target memory, correct artifact and no distractor answer', async () => {
    const result = await b10MakeAssertion(b10Ctx(b10PassWorkspace(), { mindDb: b10Db() }));
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain('target memory');
    expect(result.details.join('\n')).toContain('carries the paraphrase recall');
    expect(result.details.join('\n')).toContain('used the semantic channel');
  });

  test('B10 requires recorded semantic provenance for the target result', async () => {
    const withoutProvenance = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), { mindDb: b10Db(), sessionResults: [] })
    );
    expect(withoutProvenance.pass).toBe(false);
    expect(withoutProvenance.details.join('\n')).toContain(
      `no recorded memory_query result for '${B10_TARGET}' with semantic provenance`
    );
    // Embedding presence and a correct artifact are no longer sufficient alone.
    expect(withoutProvenance.details.join('\n')).toContain('carries the paraphrase recall');
    expect(withoutProvenance.details.join('\n')).toContain('has an embedding');

    const lexicalOnly = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), {
        mindDb: b10Db(),
        sessionResults: [
          b10SessionWithProvenance([{ name: B10_TARGET, methods: ['all', 'trigram'] }]),
        ],
      })
    );
    expect(lexicalOnly.pass).toBe(false);
    expect(lexicalOnly.details.join('\n')).toContain('with semantic provenance');

    const semantic = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), {
        mindDb: b10Db(),
        sessionResults: [b10SessionWithProvenance(B10_SEMANTIC_PROVENANCE)],
      })
    );
    expect(semantic.pass).toBe(true);
    expect(semantic.details.join('\n')).toContain(
      `recorded memory_query result for '${B10_TARGET}' used the semantic channel`
    );
  });

  test('fails when the target memory has no embedding (RAG was not applied)', async () => {
    const result = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), { mindDb: b10Db({ targetEmbedding: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('has no embedding');
  });

  test('fails when the target memory is missing', async () => {
    const result = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), { mindDb: b10Db({ targetPresent: false }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`target memory '${B10_TARGET}' is missing`);
  });

  test('fails when the artifact is missing', async () => {
    const result = await b10MakeAssertion(
      b10Ctx(mkdtempSync(join(tmpdir(), 'bench-b10-noartifact-')), { mindDb: b10Db() })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B10_ARTIFACT_FILE} was not written`);
  });

  test('fails when the artifact does not carry the target fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b10-wrong-'));
    write(join(dir, B10_ARTIFACT_FILE), 'Release credentials are renewed weekly.\n');
    const result = await b10MakeAssertion(b10Ctx(dir, { mindDb: b10Db() }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('does not contain the target fact');
  });

  test('fails when the artifact answers with the distractor fact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-b10-distractor-'));
    write(join(dir, B10_ARTIFACT_FILE), `${B10_DISTRACTOR_CONTENT}\n`);
    const result = await b10MakeAssertion(b10Ctx(dir, { mindDb: b10Db() }));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('answers with the distractor fact');
  });

  test('fails when the target name is stored twice', async () => {
    const result = await b10MakeAssertion(
      b10Ctx(b10PassWorkspace(), { mindDb: b10Db({ duplicateTarget: true }) })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('duplicate memory name');
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b10MakeAssertion(b10Ctx(b10PassWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

describe('B10 prompt and fixture hygiene', () => {
  test('the prompt has zero lexical overlap with the target fact', () => {
    const promptTokens = new Set(contentTokens(B10_PROMPTS.join(' ')));
    const targetTokens = contentTokens(B10_TARGET_CONTENT);
    expect(targetTokens.length).toBeGreaterThan(0);
    expect(targetTokens.filter(token => promptTokens.has(token))).toEqual([]);
  });

  test('the fixture does not leak the target fact', () => {
    const root = fixtureDirFor(B10_SCENARIO);
    for (const relative of ['README.md', 'package.json', 'src/deploy.ts']) {
      const content = readFileSync(join(root, relative), 'utf8').toLowerCase();
      expect(content).not.toContain('24 hours');
      expect(content).not.toContain('cryptographic');
    }
  });

  test('inspectEmbeddingCoverage reports presence without exposing raw vectors', () => {
    const coverage = inspectEmbeddingCoverage(b10Db(), B10_SPACE);
    expect(coverage).toContainEqual({ name: B10_TARGET, hasEmbedding: true });
    expect(coverage.find(entry => entry.name === B10_DISTRACTOR)?.hasEmbedding).toBe(true);
    expect(Object.keys(coverage[0]!)).toEqual(['name', 'hasEmbedding']);
  });
});

describe('B10 semantic recall gating', () => {
  test('declares RAG and the semantic-recall + mind-memory requirements', () => {
    expect(B10_SCENARIO.rag).toBe(true);
    expect(B10_SCENARIO.requires).toEqual(['mind-memory', 'semantic-recall']);
  });

  test('gates not_run under no-memory even when a credential exists', async () => {
    let sessionCalls = 0;
    const { run } = await runProbe(B10_SCENARIO, {
      conditions: ['no-memory'],
      credentialEnv: { OPENROUTER_API_KEY: 'sk-or-test-secret' },
      executor: async job => {
        sessionCalls += 1;
        return noopExecutor()(job);
      },
    });
    const result = run.results[0]!;
    expect(sessionCalls).toBe(0);
    expect(result.status).toBe('not_run');
    expect(result.notRunReason).toContain('Mind');
    expect(result.sessions).toHaveLength(0);
    expect(run.aggregates[0]).toMatchObject({ notRun: 1, failed: 0 });
  });

  test('gates not_run when the embedding credential is unavailable', async () => {
    let sessionCalls = 0;
    const { run } = await runProbe(B10_SCENARIO, {
      conditions: ['mind-v9'],
      credentialEnv: {},
      executor: async job => {
        sessionCalls += 1;
        return noopExecutor()(job);
      },
    });
    const result = run.results[0]!;
    expect(sessionCalls).toBe(0);
    expect(result.status).toBe('not_run');
    expect(result.notRunReason).toContain('OPENROUTER_API_KEY');
    expect(result.sessions).toHaveLength(0);
    expect(run.aggregates[0]).toMatchObject({ notRun: 1, failed: 0 });
  });

  test('allows the run only with a Mind condition and an embedding credential', () => {
    expect(scenarioGateReason(B10_SCENARIO, 'mind-v9', {})).toContain('OPENROUTER_API_KEY');
    expect(
      scenarioGateReason(B10_SCENARIO, 'mind-v9', { OPENROUTER_API_KEY: 'sk-or-test' })
    ).toBeNull();
    expect(
      scenarioGateReason(B10_SCENARIO, 'no-memory', { OPENROUTER_API_KEY: 'sk-or-test' })
    ).toContain('Mind');
  });

  test('a semantic-recall requirement without RAG gates not_run', () => {
    const ragless = simpleScenario({ requires: ['semantic-recall'] });
    expect(scenarioGateReason(ragless, 'mind-v9', { OPENROUTER_API_KEY: 'sk-or-test' })).toContain(
      'does not enable RAG'
    );
  });
});

describe('B10 seed', () => {
  test('stages both memories through the isolated RAG-enabled CLI', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b10-seed-')), 'mind.db');
    const env = { MIND_DB_PATH: dbPath, MIND_DATA_DIR: '/tmp/isolated-b10', MIND_RAG: 'true' };
    const calls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
    await B10_SCENARIO.seed!({
      workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b10-seed-ws-')),
      mindDb: dbPath,
      mindBin: '/fake/mind',
      env,
      run: async invocation => {
        calls.push({ args: invocation.args, env: invocation.env });
        return {
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    expect(calls.map(call => call.args[0])).toEqual(['create', 'add', 'add']);
    expect(calls[1]!.args).toContain(B10_TARGET);
    expect(calls[2]!.args).toContain(B10_DISTRACTOR);
    for (const call of calls) {
      // The seed never runs against the live database: the isolated env wins.
      expect(call.env?.MIND_DB_PATH).toBe(dbPath);
      expect(call.env?.MIND_DATA_DIR).toBe('/tmp/isolated-b10');
      expect(call.env?.MIND_RAG).toBe('true');
    }
  });

  test('refuses to seed without RAG enabled (no unembedded target)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b10-norag-')), 'mind.db');
    await expect(
      B10_SCENARIO.seed!({
        workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b10-norag-ws-')),
        mindDb: dbPath,
        mindBin: '/fake/mind',
        env: { MIND_DB_PATH: dbPath, MIND_RAG: 'false' },
        run: okRunner(),
      })
    ).rejects.toThrow('RAG');
  });
});

describe('B5/B6 prompts and seed', () => {
  test('prompts are byte-identical to the scenario definitions and name no engine', () => {
    expect(B5_SCENARIO.sessions.map(session => session.prompt)).toEqual(B5_PROMPTS);
    expect(B6_SCENARIO.sessions.map(session => session.prompt)).toEqual(B6_PROMPTS);
    expect(B7_SCENARIO.sessions.map(session => session.prompt)).toEqual(B7_PROMPTS);
    expect(B8_SCENARIO.sessions.map(session => session.prompt)).toEqual(B8_PROMPTS);
    expect(B9_SCENARIO.sessions.map(session => session.prompt)).toEqual(B9_PROMPTS);
    expect(B10_SCENARIO.sessions.map(session => session.prompt)).toEqual(B10_PROMPTS);
    expect(B11_SCENARIO.sessions.map(session => session.prompt)).toEqual(B11_PROMPTS);
    for (const prompt of [
      ...B5_PROMPTS,
      ...B6_PROMPTS,
      ...B7_PROMPTS,
      ...B8_PROMPTS,
      ...B9_PROMPTS,
      ...B10_PROMPTS,
      ...B11_PROMPTS,
    ]) {
      expect(prompt).not.toMatch(/\bmind\b/i);
      expect(prompt).not.toMatch(/\bengine\b/i);
    }
  });

  test('prompts are byte-identical across conditions', async () => {
    const initMindDb = async (input: InitMindDbInput): Promise<void> => {
      mkdirSync(input.dirs.mindDataDir, { recursive: true });
      const db = new Database(input.dirs.mindDb);
      db.exec(`
        CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE memories (id TEXT PRIMARY KEY, space_id TEXT, name TEXT, content TEXT, tier INTEGER, pinned INTEGER, changed_at TEXT);
        CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
        CREATE TABLE links (source_id TEXT, target_id TEXT, label TEXT, created_at TEXT);
      `);
      db.close();
    };
    for (const scenario of [
      B5_SCENARIO,
      B6_SCENARIO,
      B7_SCENARIO,
      B8_SCENARIO,
      B9_SCENARIO,
      B10_SCENARIO,
      B11_SCENARIO,
    ]) {
      const { run } = await runProbe(scenario, {
        conditions: ['no-memory', 'mind-v9'],
        initMindDb,
      });
      expect(run.results).toHaveLength(2);
      expect(run.results[0]!.prompts).toEqual(run.results[1]!.prompts);
    }
  });

  test('B6 seed stages the two memories and stale link through the isolated CLI', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b6-seed-')), 'mind.db');
    const env = { MIND_DB_PATH: dbPath };
    const calls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
    await B6_SCENARIO.seed!({
      workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b6-seed-ws-')),
      mindDb: dbPath,
      mindBin: '/fake/mind',
      env,
      run: async invocation => {
        calls.push({ args: invocation.args, env: invocation.env });
        return {
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    expect(calls.map(call => call.args[0])).toEqual(['create', 'add', 'add', 'link']);
    expect(calls[1]!.args).toContain(B6_STRATEGY);
    expect(calls[2]!.args).toContain(B6_IMPLEMENTATION);
    expect(calls[3]!.args).toContain('--label');
    expect(calls[3]!.args).toContain(B6_STALE_LABEL);
    for (const call of calls) {
      expect(call.env?.MIND_DB_PATH).toBe(dbPath);
    }
  });

  test('B7 seed stages the historical decision through the isolated CLI', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b7-seed-')), 'mind.db');
    const env = { MIND_DB_PATH: dbPath };
    const calls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
    await B7_SCENARIO.seed!({
      workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b7-seed-ws-')),
      mindDb: dbPath,
      mindBin: '/fake/mind',
      env,
      run: async invocation => {
        calls.push({ args: invocation.args, env: invocation.env });
        return {
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    expect(calls.map(call => call.args[0])).toEqual(['create', 'add']);
    expect(calls[0]!.args).toContain(B7_SPACE);
    expect(calls[1]!.args).toContain(B7_SPACE);
    expect(calls[1]!.args).toContain(B7_OLD_NAME);
    expect(calls[1]!.args).toContain('--tags');
    expect(calls[1]!.args).toContain(B7_OLD_CATEGORY_TAG);
    for (const call of calls) {
      expect(call.env?.MIND_DB_PATH).toBe(dbPath);
    }
  });

  test('B8 seed stages the two T2 memories through the isolated CLI', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b8-seed-')), 'mind.db');
    const env = { MIND_DB_PATH: dbPath, MIND_DATA_DIR: '/tmp/isolated-b8' };
    const calls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
    await B8_SCENARIO.seed!({
      workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b8-seed-ws-')),
      mindDb: dbPath,
      mindBin: '/fake/mind',
      env,
      run: async invocation => {
        calls.push({ args: invocation.args, env: invocation.env });
        return {
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    });
    expect(calls.map(call => call.args[0])).toEqual(['create', 'add', 'add']);
    expect(calls[0]!.args).toContain(B8_SPACE);
    expect(calls[1]!.args).toContain(B8_CHECKLIST);
    expect(calls[1]!.args).toContain(B8_CHECKLIST_TAG);
    expect(calls[1]!.args).toContain('--tier');
    expect(calls[2]!.args).toContain(B8_BACKGROUND);
    expect(calls[2]!.args).toContain(B8_BACKGROUND_TAG);
    for (const call of calls) {
      // The seed never runs against the live database: the isolated env wins.
      expect(call.env?.MIND_DB_PATH).toBe(dbPath);
      expect(call.env?.MIND_DATA_DIR).toBe('/tmp/isolated-b8');
    }
  });
});

// ── Runner lifecycle with a fake driver ──────────────────────────────────────

interface RunHarness {
  readonly runDir: string;
  readonly run: ScenariosRunResult;
  readonly initCalls: InitMindDbInput[];
}

function buildScripts(
  conditions: readonly ConditionId[],
  scenarioIds: readonly string[]
): FakeSessionScript[] {
  const scripts: FakeSessionScript[] = [];
  for (const condition of conditions) {
    for (const id of scenarioIds) {
      for (let index = 0; index < 2; index++) {
        scripts.push({
          text: `${condition}/${id}#${index}`,
          cost: 0.001,
          toolNames: condition === 'no-memory' ? [] : ['mind_memory_query'],
          children: id === 'b4' && index === 1 ? ['ses_child_b4'] : [],
        });
      }
    }
  }
  return scripts;
}

function executorFrom(
  driver: ReturnType<typeof createFakeSessionDriver>,
  onJob?: (job: { scenarioId: string; workspaceDir: string }) => void
): BSessionExecutor {
  return async job => {
    onJob?.({ scenarioId: job.scenarioId, workspaceDir: job.workspaceDir });
    const result = await driver.runPrompt({
      workspaceDir: job.workspaceDir,
      prompt: job.prompt,
      limits: job.limits,
    });
    const children: BChildResult[] = [];
    for (const id of await driver.children(result.sessionId)) {
      children.push({
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
      });
    }
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
      evidence: buildDriverEvidence({
        sessionId: result.sessionId,
        messages: [],
        childSessionIds: children.map(captured => captured.sessionId),
        idleOutcome: 'succeeded',
      }),
    } satisfies BSessionOutcome & { evidence: DriverEvidence };
  };
}

async function runHarness(
  conditions: readonly ConditionId[],
  options: {
    maxCostUsd?: number | null;
    costPerSession?: number;
    scenarios?: readonly string[];
    onJob?: (job: { scenarioId: string; workspaceDir: string }) => void;
    selectAll?: boolean;
    prepareUnit?: PrepareUnit;
  } = {}
): Promise<RunHarness> {
  const runDir = mkdtempSync(join(tmpdir(), 'bench-b-run-'));
  const scenarioIds = options.scenarios ?? ['b1', 'b4'];
  const scripts = buildScripts(conditions, scenarioIds).map(script => ({
    ...script,
    cost: options.costPerSession ?? script.cost,
  }));
  const driver = createFakeSessionDriver(scripts);
  const initCalls: InitMindDbInput[] = [];

  const run = await runScenarioRun(
    {
      runId: 'run-test',
      runDir,
      conditions,
      scenarios: SCENARIOS.filter(s => scenarioIds.includes(s.id)),
      limits: { steps: 3, timeoutMs: 1000 },
      budget: new BudgetGuard({
        maxCostUsd: options.maxCostUsd === undefined ? 5 : options.maxCostUsd,
      }),
      stdout: () => undefined,
      stderr: () => undefined,
    },
    {
      fixtureDirFor,
      worktrees: { v9: '/fake/v9', v10: '/fake/v10' },
      executor: executorFrom(driver, options.onJob),
      runner: okRunner(),
      prepareUnit: options.prepareUnit,
      initMindDb: async input => {
        initCalls.push(input);
        mkdirSync(input.dirs.mindDataDir, { recursive: true });
        const db = new Database(input.dirs.mindDb);
        db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
        db.close();
      },
    }
  );

  return { runDir, run, initCalls };
}

describe('runScenarioRun lifecycle', () => {
  test('runs sessions sequentially per (scenario × condition) and records assertions', async () => {
    const { run } = await runHarness(['no-memory', 'mind-v9']);
    expect(run.results).toHaveLength(4);
    const b4 = run.results.find(r => r.scenarioId === 'b4' && r.condition === 'no-memory')!;
    expect(b4.sessions).toHaveLength(2);
    expect(b4.childCount).toBe(1);
    // The b4 assertion passes with a fake passing test suite + a captured child.
    expect(b4.assertion.pass).toBe(true);
    // 2 conditions × 2 scenarios × 2 sessions × $0.001.
    expect(run.spentUsd).toBeCloseTo(0.008, 6);
    const aggregates = Object.fromEntries(run.aggregates.map(a => [a.condition, a]));
    expect(aggregates['no-memory']!.childSessions).toBe(1);
    expect(aggregates['mind-v9']!.memoryCalls).toBeGreaterThan(0);
  });

  test('creates a FRESH EMPTY Mind database per unit and none for no-memory', async () => {
    const { run, initCalls } = await runHarness(['no-memory', 'mind-v9']);
    expect(initCalls).toHaveLength(2); // b1 + b4 for mind-v9 only
    const mind = run.results.filter(r => r.condition === 'mind-v9');
    for (const result of mind) {
      expect(result.mindDb).not.toBeNull();
      const db = new Database(result.mindDb!, { readonly: true });
      const count = db.query('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      db.close();
      expect(count.n).toBe(0);
    }
    const baseline = run.results.filter(r => r.condition === 'no-memory');
    expect(baseline.every(r => r.mindDb === null)).toBe(true);
  });

  test('sends byte-identical prompts across every condition', async () => {
    const conditions: ConditionId[] = ['no-memory', 'mind-v9', 'mind-v10'];
    const { run } = await runHarness(conditions);
    const byCondition = (condition: ConditionId) =>
      run.results.filter(r => r.condition === condition).flatMap(r => r.prompts);
    const first = byCondition('no-memory');
    expect(first.length).toBe(4);
    expect(byCondition('mind-v9')).toEqual(first);
    expect(byCondition('mind-v10')).toEqual(first);
  });

  test('captures child sessions linked to their parent', async () => {
    const { run } = await runHarness(['no-memory']);
    const b4 = run.results.find(r => r.scenarioId === 'b4')!;
    expect(b4.childResults).toHaveLength(1);
    expect(b4.childResults[0]!.sessionId).toBe('ses_child_b4');
  });

  test('records a harness-error assertion as not_run, never as a failure', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-b-harness-'));
    const driver = createFakeSessionDriver([
      { text: 'probe answer', cost: 0, toolNames: [], children: [] },
    ]);
    const probe: Scenario = {
      id: 'bhx',
      title: 'Harness error probe',
      fixture: 'fixtures/b1',
      sessions: [{ prompt: 'probe' }],
      makeAssertion: async () => ({
        pass: false,
        details: ['harness error: session 2: message evidence unavailable'],
      }),
    };

    const run = await runScenarioRun(
      {
        runId: 'run-harness-error',
        runDir,
        conditions: ['no-memory'],
        scenarios: [probe],
        limits: { steps: 1, timeoutMs: 1000 },
        budget: new BudgetGuard({ maxCostUsd: 1 }),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      {
        fixtureDirFor,
        worktrees: {},
        executor: executorFrom(driver),
        runner: okRunner(),
      }
    );

    const result = run.results[0]!;
    expect(result.status).toBe('not_run');
    expect(result.harnessError).toContain('message evidence unavailable');
    expect(run.aggregates[0]).toMatchObject({ passed: 0, failed: 0, notRun: 1 });
  });
});

describe('runScenarioRun budget', () => {
  test('aborts when accumulated cost crosses the cap', async () => {
    await expect(
      runHarness(['no-memory'], { maxCostUsd: 0.001, costPerSession: 0.002 })
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test('refuses to spend when no budget is approved', async () => {
    await expect(
      runHarness(['no-memory'], { maxCostUsd: null, costPerSession: 0.002 })
    ).rejects.toThrow('no budget approved');
  });
});

// ── Dry-run sanity (all conditions × both scenarios, no network) ─────────────

describe('benchmark B dry-run sanity', () => {
  test('runs all 3 conditions × both scenarios with a fake driver and fakes everything green', async () => {
    const conditions: ConditionId[] = ['no-memory', 'mind-v9', 'mind-v10'];
    const { run } = await runHarness(conditions, {
      onJob: ({ scenarioId, workspaceDir }) => {
        if (scenarioId !== 'b1') return;
        write(
          join(workspaceDir, 'data', 'tasks.json'),
          JSON.stringify({ exportedAt: '2026-10-18T00:00:00.000Z', tasks: [] })
        );
      },
    });

    expect(run.results).toHaveLength(6);
    for (const aggregate of run.aggregates) {
      expect(aggregate.scenarios).toBe(2);
      expect(aggregate.passed).toBe(2);
      expect(aggregate.failed).toBe(0);
    }
  });
});

// ── D7 harness capabilities: mind-current, RAG, gating, seeding ──────────────

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function simpleScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'b-probe',
    title: 'D7 probe',
    fixture: 'fixtures/b1',
    sessions: [{ prompt: 'first' }, { prompt: 'second' }],
    makeAssertion: () => ({ pass: true, details: ['ok'] }),
    ...overrides,
  };
}

function noopExecutor(
  onJob?: (job: { scenarioId: string; env: Record<string, string> }) => void
): BSessionExecutor {
  return async job => {
    onJob?.({ scenarioId: job.scenarioId, env: job.env });
    return {
      status: 'ok',
      sessionId: `ses_${job.sessionIndex}`,
      finalText: '',
      toolCalls: [],
      memoryCalls: 0,
      model: null,
      tokens: null,
      costUsd: 0,
      latencyMs: 0,
      steps: 0,
      finish: 'stop',
      error: null,
      errorType: null,
      isolationOk: true,
      children: [],
      rawMessages: { data: [] },
    };
  };
}

async function runProbe(
  scenario: Scenario,
  options: {
    conditions?: readonly ConditionId[];
    credentialEnv?: Record<string, string>;
    executor?: BSessionExecutor;
    initMindDb?: (input: InitMindDbInput) => Promise<void>;
    prepareUnit?: PrepareUnit;
  } = {}
) {
  const runDir = mkdtempSync(join(tmpdir(), 'bench-b-d7-'));
  const created: string[] = [];
  const run = await runScenarioRun(
    {
      runId: 'run-d7',
      runDir,
      conditions: options.conditions ?? ['mind-v9'],
      scenarios: [scenario],
      limits: { steps: 2, timeoutMs: 1000 },
      budget: new BudgetGuard({ maxCostUsd: 5 }),
      stdout: () => undefined,
      stderr: () => undefined,
      credentialEnv: options.credentialEnv,
    },
    {
      fixtureDirFor,
      worktrees: { v9: '/fake/v9', v10: '/fake/v10', current: '/fake/current' },
      executor: options.executor ?? noopExecutor(),
      runner: okRunner(),
      // Unit probes never run the real installer unless a test opts in.
      prepareUnit: options.prepareUnit ?? (async ({ env }) => env),
      initMindDb:
        options.initMindDb ??
        (async input => {
          created.push(input.dirs.mindDb);
          mkdirSync(input.dirs.mindDataDir, { recursive: true });
          const db = new Database(input.dirs.mindDb);
          db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY)');
          db.close();
        }),
    }
  );
  return { runDir, run, created };
}

describe('mind-current condition', () => {
  test('runs the local checkout (worktrees.current) with its own isolated DB', async () => {
    const { run, created } = await runProbe(simpleScenario(), {
      conditions: ['mind-current'],
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('b-probe');
    const result = run.results[0]!;
    expect(result.condition).toBe('mind-current');
    expect(result.mindDb).not.toBeNull();
    expect(result.mindDb).toContain('mind-current');
    expect(result.sessions).toHaveLength(2);
  });
});

describe('current skill-first preparation', () => {
  test('prepares exactly once before the seed and both sessions with the prepared env', async () => {
    const events: string[] = [];
    const seenEnvs: Record<string, string>[] = [];
    const scenario = simpleScenario({
      seed: ({ env }) => {
        events.push('seed');
        seenEnvs.push(env);
      },
    });
    const { run } = await runProbe(scenario, {
      conditions: ['mind-current'],
      prepareUnit: async ({ dir, env, mindBin, run: runCmd }) => {
        events.push('prepare');
        expect(mindBin).toBe('/fake/current/mind');
        expect(dir.home).toContain('b-probe');
        expect(runCmd).toBeTypeOf('function');
        return { ...env, PREPARED: 'yes' };
      },
      executor: async job => {
        events.push(`session${job.sessionIndex}`);
        seenEnvs.push(job.env);
        return noopExecutor()(job);
      },
    });

    expect(events).toEqual(['prepare', 'seed', 'session0', 'session1']);
    expect(seenEnvs).toHaveLength(3);
    for (const env of seenEnvs) {
      expect(env.PREPARED).toBe('yes');
    }
    expect(run.results[0]!.sessions).toHaveLength(2);
  });

  test('never prepares historical or no-memory units', async () => {
    let prepareCalls = 0;
    const { run } = await runProbe(simpleScenario(), {
      conditions: ['no-memory', 'mind-v9', 'mind-v10'],
      prepareUnit: async ({ env }) => {
        prepareCalls += 1;
        return env;
      },
    });
    expect(prepareCalls).toBe(0);
    expect(run.results).toHaveLength(3);
  });

  test('a preparation failure rejects before any seed, database or session', async () => {
    let sessionCalls = 0;
    let seedCalls = 0;
    const scenario = simpleScenario({
      seed: () => {
        seedCalls += 1;
      },
    });
    const promise = runProbe(scenario, {
      conditions: ['mind-current'],
      prepareUnit: async () => {
        throw new Error('prep failed');
      },
      executor: async job => {
        sessionCalls += 1;
        return noopExecutor()(job);
      },
    });

    await expect(promise).rejects.toThrow('prep failed');
    expect(sessionCalls).toBe(0);
    expect(seedCalls).toBe(0);
  });

  test('B11 stays not_run outside mind-current and never prepares', async () => {
    let prepareCalls = 0;
    const { run } = await runHarness(['no-memory', 'mind-v9'], {
      scenarios: ['b11'],
      prepareUnit: async ({ env }) => {
        prepareCalls += 1;
        return env;
      },
    });
    expect(prepareCalls).toBe(0);
    expect(run.results.map(result => result.status)).toEqual(['not_run', 'not_run']);
    for (const result of run.results) {
      expect(result.sessions).toHaveLength(0);
    }
  });
});

describe('per-session OpenCode database', () => {
  test('each session gets its own OpenCode DB while the Mind DB stays shared per unit', async () => {
    const jobs: BSessionJob[] = [];
    await runProbe(simpleScenario(), {
      executor: async job => {
        jobs.push(job);
        return noopExecutor()(job);
      },
    });

    expect(jobs).toHaveLength(2);
    const [first, second] = jobs as [BSessionJob, BSessionJob];
    const unitDir = dirname(dirname(first.sessionDir));

    // Isolation leak regression: a shared OpenCode DB let session 0 persist and
    // session 1's fail-closed empty-session check reject it as contamination.
    expect(first.env.OPENCODE_DB).not.toBe(second.env.OPENCODE_DB);

    for (const job of jobs) {
      const dbPath = job.env.OPENCODE_DB!;
      // Contained in the unit directory so the existing path gate stays as-is.
      expect(dbPath.startsWith(unitDir)).toBe(true);
      // Owned by its own session directory, not the unit-level OpenCode tree.
      expect(dirname(dbPath)).toBe(job.sessionDir);
    }

    // Continuity is carried by the shared Mind DB, not the session store.
    expect(first.env.MIND_DB_PATH).toBe(second.env.MIND_DB_PATH);
    expect(first.mindDbPath).toBe(second.mindDbPath);
    expect(first.env.MIND_DB_PATH).toBe(first.mindDbPath!);
  });
});

describe('per-scenario RAG toggle', () => {
  test('sets MIND_RAG and the provider only when the scenario asks for it', async () => {
    const seen: Record<string, string>[] = [];
    await runProbe(simpleScenario(), { executor: noopExecutor(job => seen.push(job.env)) });

    const ragSeen: Record<string, string>[] = [];
    await runProbe(simpleScenario({ rag: true }), {
      credentialEnv: { OPENROUTER_API_KEY: 'sk-or-test-secret' },
      executor: noopExecutor(job => ragSeen.push(job.env)),
    });

    expect(seen[0]!.MIND_RAG).toBe('false');
    expect(seen[0]!.MIND_EMBEDDING_PROVIDER).toBeUndefined();
    expect(ragSeen[0]!.MIND_RAG).toBe('true');
    expect(ragSeen[0]!.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
    expect(ragSeen[0]!.OPENROUTER_API_KEY).toBe('sk-or-test-secret');
  });

  test('keeps the raw key only in the child env, never in persisted artifacts', async () => {
    const secret = 'sk-or-test-secret-do-not-persist';
    const seen: Record<string, string>[] = [];
    const { runDir } = await runProbe(simpleScenario({ rag: true }), {
      credentialEnv: { OPENROUTER_API_KEY: secret },
      executor: noopExecutor(job => seen.push(job.env)),
    });

    expect(seen[0]!.OPENROUTER_API_KEY).toBe(secret);
    const persisted = filesUnder(runDir).filter(path => !path.endsWith('.db'));
    for (const path of persisted) {
      expect(readFileSync(path, 'utf8')).not.toContain(secret);
    }
  });

  test('marks a RAG scenario not_run when no embedding credential is available', async () => {
    let calls = 0;
    const { run } = await runProbe(simpleScenario({ rag: true }), {
      credentialEnv: {},
      executor: async job => {
        calls += 1;
        return noopExecutor()(job);
      },
    });
    const result = run.results[0]!;
    expect(calls).toBe(0);
    expect(result.status).toBe('not_run');
    expect(result.notRunReason).toContain('OPENROUTER_API_KEY');
    expect(result.sessions).toHaveLength(0);
    expect(run.aggregates[0]!.notRun).toBe(1);
  });
});

describe('scenario requirements gating', () => {
  test('marks a tier-maintenance scenario not_run on a pinned condition', async () => {
    const { run } = await runProbe(simpleScenario({ requires: ['tier-maintenance'] }), {
      conditions: ['mind-v9'],
    });
    expect(run.results[0]!.status).toBe('not_run');
    expect(run.results[0]!.notRunReason).toContain('mind-current');
  });

  test('runs the same scenario on mind-current', async () => {
    const { run } = await runProbe(simpleScenario({ requires: ['tier-maintenance'] }), {
      conditions: ['mind-current'],
    });
    expect(run.results[0]!.status).toBe('passed');
    expect(run.results[0]!.notRunReason).toBeNull();
  });

  test('gates a skill-first scenario to mind-current only', () => {
    const scenario = simpleScenario({ requires: ['skill-first'] });
    expect(scenarioGateReason(scenario, 'no-memory', {})).toContain('skill-first');
    expect(scenarioGateReason(scenario, 'mind-v9', {})).toContain('skill-first');
    expect(scenarioGateReason(scenario, 'mind-v10', {})).toContain('skill-first');
    expect(scenarioGateReason(scenario, 'mind-current', {})).toBeNull();
    // B11 keeps the Mind reason first and the current-only reason second.
    expect(B11_SCENARIO.requires).toEqual(['mind-memory', 'skill-first']);
    expect(scenarioGateReason(B11_SCENARIO, 'no-memory', {})).toContain('Mind');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-v9', {})).toContain('mind-current');
  });

  test('B11 runs only on mind-current; the other three are not_run with zero failures', async () => {
    const probe: Scenario = {
      ...B11_SCENARIO,
      seed: undefined,
      makeAssertion: () => ({ pass: true, details: ['probe'] }),
    };
    const { run } = await runProbe(probe, {
      conditions: ['no-memory', 'mind-v9', 'mind-v10', 'mind-current'],
    });
    const byCondition = Object.fromEntries(run.results.map(result => [result.condition, result]));

    expect(byCondition['no-memory']!.notRunReason).toContain('Mind');
    for (const condition of ['mind-v9', 'mind-v10'] as const) {
      const result = byCondition[condition]!;
      expect(result.status).toBe('not_run');
      expect(result.notRunReason).toContain('skill-first');
      expect(result.sessions).toHaveLength(0);
    }
    expect(byCondition['mind-current']!.notRunReason).toBeNull();
    expect(byCondition['mind-current']!.sessions).toHaveLength(2);

    expect(run.aggregates.reduce((total, entry) => total + entry.notRun, 0)).toBe(3);
    for (const condition of ['no-memory', 'mind-v9', 'mind-v10'] as const) {
      const aggregate = run.aggregates.find(entry => entry.condition === condition)!;
      expect(aggregate).toMatchObject({ notRun: 1, failed: 0 });
    }
  });

  test('gates B5/B6 not_run under no-memory without sessions or failures', async () => {
    let sessionCalls = 0;
    const { run } = await runHarness(['no-memory'], {
      scenarios: ['b5', 'b6'],
      onJob: () => {
        sessionCalls += 1;
      },
    });
    expect(sessionCalls).toBe(0);
    expect(run.aggregates[0]).toMatchObject({ scenarios: 2, notRun: 2, failed: 0 });
    expect(run.aggregates[0]!.passed).toBe(0);
    for (const result of run.results) {
      expect(result.status).toBe('not_run');
      expect(result.sessions).toHaveLength(0);
      expect(result.notRunReason).toContain('Mind');
    }
  });

  test('gates B7/B9 not_run under no-memory with zero sessions and no failures', async () => {
    let sessionCalls = 0;
    const { run } = await runHarness(['no-memory'], {
      scenarios: ['b7', 'b9'],
      onJob: () => {
        sessionCalls += 1;
      },
    });
    expect(sessionCalls).toBe(0);
    expect(run.aggregates[0]).toMatchObject({ scenarios: 2, notRun: 2, failed: 0 });
    expect(run.aggregates[0]!.passed).toBe(0);
    for (const result of run.results) {
      expect(result.status).toBe('not_run');
      expect(result.sessions).toHaveLength(0);
      expect(result.notRunReason).toContain('Mind');
    }
    expect(B7_SCENARIO.requires).toEqual(['mind-memory']);
    expect(B9_SCENARIO.requires).toEqual(['mind-memory']);
  });

  test('gates B8 not_run under no-memory with zero sessions and no failures', async () => {
    let sessionCalls = 0;
    const { run } = await runHarness(['no-memory'], {
      scenarios: ['b8'],
      onJob: () => {
        sessionCalls += 1;
      },
    });
    expect(sessionCalls).toBe(0);
    expect(run.aggregates[0]).toMatchObject({ scenarios: 1, notRun: 1, failed: 0 });
    expect(run.aggregates[0]!.passed).toBe(0);
    const result = run.results[0]!;
    expect(result.status).toBe('not_run');
    expect(result.sessions).toHaveLength(0);
    expect(result.notRunReason).toContain('Mind');
    expect(B8_SCENARIO.requires).toEqual(['mind-memory']);
  });
});

describe('scenario seed hook', () => {
  test('receives the unit database and runs after it exists, before sessions', async () => {
    let seeded = false;
    let dbExisted = false;
    let sessionSawSeed = false;
    const scenario = simpleScenario({
      seed: ({ mindDb, run: runCmd }) => {
        seeded = true;
        dbExisted = mindDb !== null && existsSync(mindDb);
        expect(runCmd).toBeTypeOf('function');
      },
    });
    const { run } = await runProbe(scenario, {
      executor: async job => {
        sessionSawSeed = seeded && dbExisted;
        return noopExecutor()(job);
      },
    });
    expect(sessionSawSeed).toBe(true);
    expect(run.results[0]!.status).toBe('passed');
  });
});
