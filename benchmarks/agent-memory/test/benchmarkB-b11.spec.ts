// Unit tests for scenario B11 (skill-first activation + pending-work continuity).
// Synthetic raw transcripts and temporary databases only: no OpenCode, no model.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
  runScenarioRun,
  scenarioGateReason,
  type BSessionExecutor,
  type InitMindDbInput,
  type ScenariosRunResult,
} from '../src/benchmarkB/runner';
import type {
  BSessionResult,
  BSessionStatus,
  Scenario,
  ScenarioAssertionContext,
} from '../src/benchmarkB/scenario';
import {
  B11_ARTIFACT_FILE,
  B11_PENDING_ITEM,
  B11_PROMPTS,
  B11_SCENARIO,
  B11_SKILL_ID,
  analyzeTranscripts,
  extractToolInvocations,
  makeAssertion as b11MakeAssertion,
  type SessionEvidenceView,
} from '../src/benchmarkB/scenarios/b11/index';
import { SCENARIO_IDS } from '../src/benchmarkB/scenarios/registry';
import { BudgetGuard } from '../src/budget';
import type { ConditionId } from '../src/config';
import type { CommandRunner } from '../src/exec';
import { buildDriverEvidence, type DriverEvidence } from '../src/opencode/driver';

const HARNESS_ROOT = join(import.meta.dir, '..');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function tool(
  name: string,
  input: Record<string, unknown> = {},
  nested: readonly { tool: string; args?: Record<string, unknown> }[] = []
): unknown {
  const state: Record<string, unknown> = { input };
  if (nested.length > 0) state.metadata = { toolCalls: nested };
  return { type: 'tool', name, state };
}

function assistant(...parts: unknown[]): unknown {
  return { type: 'assistant', content: parts };
}

function messageList(rawMessages: unknown): unknown[] {
  const record =
    rawMessages && typeof rawMessages === 'object'
      ? (rawMessages as { data?: unknown }).data
      : undefined;
  return Array.isArray(record) ? record : Array.isArray(rawMessages) ? rawMessages : [];
}

function capturedEvidence(rawMessages: unknown, sessionId: string): DriverEvidence {
  return buildDriverEvidence({
    sessionId,
    messages: messageList(rawMessages),
    childSessionIds: [],
    idleOutcome: 'succeeded',
  });
}

function session(
  rawMessages: unknown,
  status: BSessionStatus = 'ok'
): SessionEvidenceView & Pick<BSessionResult, 'rawMessages' | 'status'> {
  return {
    rawMessages,
    status,
    evidence: capturedEvidence(rawMessages, 'ses_analysis'),
  };
}

function skillMessage(id: string = B11_SKILL_ID, name: string = B11_SKILL_ID): unknown {
  return { type: 'skill', skill: id, name };
}

function sessionResult(
  rawMessages: unknown,
  sessionIndex: number,
  status: BSessionStatus = 'ok'
): BSessionResult & { evidence: DriverEvidence } {
  return {
    status,
    sessionId: `ses_${sessionIndex + 1}`,
    finalText: '',
    toolCalls: [],
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
    rawMessages,
    sessionIndex,
    prompt: B11_PROMPTS[sessionIndex] ?? B11_PROMPTS[0]!,
    evidence: capturedEvidence(rawMessages, `ses_${sessionIndex + 1}`),
  };
}

function unavailableSessionResult(sessionIndex: number): BSessionResult & {
  evidence: DriverEvidence;
} {
  const rawMessages = { data: [] };
  return {
    ...sessionResult(rawMessages, sessionIndex),
    evidence: buildDriverEvidence({
      sessionId: `ses_${sessionIndex + 1}`,
      messages: null,
      childSessionIds: [],
      idleOutcome: 'succeeded',
      reason: 'message capture failed',
    }),
  };
}

function sessionResults(raw: unknown): BSessionResult[] {
  return [sessionResult(raw, 0), sessionResult(raw, 1)];
}

function createCheckpointDb(pending: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b11-db-'));
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
      changed_at TEXT
    );
    CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
    CREATE TABLE links (source_id TEXT, target_id TEXT, label TEXT, created_at TEXT);
  `);
  db.query('INSERT INTO spaces (id, name) VALUES (?, ?)').run('s1', 'projects/b11-app');
  if (pending !== null) {
    db.query(
      'INSERT INTO memories (id, space_id, name, content, tier, pinned, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'm1',
      's1',
      'checkpoint-release',
      JSON.stringify({ goal: 'Prepare the release', pending, notes: '' }),
      2,
      0,
      '2026-10-20T00:00:00Z'
    );
    db.query('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)').run('m1', 'checkpoint');
    db.query('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)').run('m1', 'type:session');
  }
  db.close();
  return path;
}

function passTranscript(): unknown {
  return {
    data: [
      assistant(tool('skill', { id: B11_SKILL_ID })),
      assistant(tool('mind_checkpoint_save', { space: 'projects/b11-app' })),
    ],
  };
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
    run: (async invocation => ({
      command: invocation.command,
      args: invocation.args,
      stdout: '',
      stderr: '',
      exitCode: 0,
    })) as CommandRunner,
    ...overrides,
  };
}

function passWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-b11-ws-'));
  write(join(dir, B11_ARTIFACT_FILE), `${B11_PENDING_ITEM}\n`);
  return dir;
}

/**
 * B11 gate probe: keeps B11's registry identity and requirements, but drops the
 * real seed/assertion so the matrix proves eligibility without paid work.
 */
function gateProbeScenario(): Scenario {
  return {
    ...B11_SCENARIO,
    seed: undefined,
    makeAssertion: () => ({ pass: true, details: ['gate probe'] }),
  };
}

interface GateProbeResult {
  readonly run: ScenariosRunResult;
  readonly executorCalls: string[];
  readonly initCalls: InitMindDbInput[];
}

async function runGateProbe(conditions: readonly ConditionId[]): Promise<GateProbeResult> {
  const runDir = mkdtempSync(join(tmpdir(), 'bench-b11-gate-'));
  const executorCalls: string[] = [];
  const initCalls: InitMindDbInput[] = [];
  const executor: BSessionExecutor = async job => {
    executorCalls.push(`${job.scenarioId}/${job.condition}/${job.sessionIndex}`);
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

  const run = await runScenarioRun(
    {
      runId: 'run-gate',
      runDir,
      conditions,
      scenarios: [gateProbeScenario()],
      limits: { steps: 2, timeoutMs: 1000 },
      budget: new BudgetGuard({ maxCostUsd: 5 }),
      stdout: () => undefined,
      stderr: () => undefined,
      credentialEnv: {},
    },
    {
      fixtureDirFor: () => join(HARNESS_ROOT, B11_SCENARIO.fixture),
      worktrees: { v9: '/fake/v9', v10: '/fake/v10', current: '/fake/current' },
      executor,
      // The unit-level tests exercise gating, not the real installer.
      prepareUnit: async ({ env }) => env,
      runner: async invocation => ({
        command: invocation.command,
        args: invocation.args,
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
      initMindDb: async input => {
        initCalls.push(input);
        mkdirSync(input.dirs.mindDataDir, { recursive: true });
        const db = new Database(input.dirs.mindDb);
        db.exec(`
          CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT UNIQUE);
          CREATE TABLE memories (
            id TEXT PRIMARY KEY, space_id TEXT, name TEXT, content TEXT,
            tier INTEGER, pinned INTEGER, changed_at TEXT
          );
          CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
          CREATE TABLE links (source_id TEXT, target_id TEXT, label TEXT, created_at TEXT);
        `);
        db.close();
      },
    }
  );

  return { run, executorCalls, initCalls };
}

describe('B11 registry and gating', () => {
  test('is registered after B10 and declares mind-memory plus skill-first without RAG', () => {
    expect(SCENARIO_IDS).toEqual(['b1', 'b4', 'b5', 'b6', 'b7', 'b9', 'b8', 'b10', 'b11']);
    expect(B11_SCENARIO.requires).toEqual(['mind-memory', 'skill-first']);
    expect(B11_SCENARIO.rag).toBeUndefined();
    expect(B11_SCENARIO.fixture).toBe('fixtures/b11');
    // The shared runner preparation owns setup; B11 has no seed-time installer.
    expect(B11_SCENARIO.seed).toBeUndefined();
  });

  test('gates not_run under no-memory instead of running a memory task', () => {
    expect(scenarioGateReason(B11_SCENARIO, 'no-memory', {})).toContain('Mind');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-v9', {})).toContain('skill-first');
  });

  test('is eligible only on mind-current across the four conditions', () => {
    expect(scenarioGateReason(B11_SCENARIO, 'no-memory', {})).toContain('Mind');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-v9', {})).toContain('mind-current');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-v10', {})).toContain('mind-current');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-current', {})).toBeNull();
  });

  test('gated conditions execute zero sessions, zero cost, no DB and no executor calls', async () => {
    const { run, executorCalls, initCalls } = await runGateProbe([
      'no-memory',
      'mind-v9',
      'mind-v10',
      'mind-current',
    ]);
    const byCondition = Object.fromEntries(run.results.map(result => [result.condition, result]));

    const noMemory = byCondition['no-memory']!;
    expect(noMemory.status).toBe('not_run');
    expect(noMemory.notRunReason).toContain('Mind');

    for (const condition of ['mind-v9', 'mind-v10'] as const) {
      const result = byCondition[condition]!;
      expect(result.status).toBe('not_run');
      expect(result.notRunReason).toContain('skill-first');
      expect(result.notRunReason).toContain('mind-current');
      expect(result.sessions).toHaveLength(0);
      expect(result.costUsd).toBe(0);
      expect(result.mindDb).toBeNull();
    }

    const current = byCondition['mind-current']!;
    expect(current.notRunReason).toBeNull();
    expect(current.sessions).toHaveLength(2);

    // Only the eligible condition initializes a DB or reaches the executor.
    expect(initCalls).toHaveLength(1);
    expect(executorCalls).toEqual(['b11/mind-current/0', 'b11/mind-current/1']);
    expect(run.spentUsd).toBe(0);

    const aggregates = Object.fromEntries(run.aggregates.map(entry => [entry.condition, entry]));
    for (const condition of ['no-memory', 'mind-v9', 'mind-v10'] as const) {
      expect(aggregates[condition]).toMatchObject({ notRun: 1, failed: 0, costUsd: 0 });
    }
    expect(aggregates['mind-current']).toMatchObject({ notRun: 0, failed: 0 });
  });

  test('prompts are byte-identical and name no engine or product', () => {
    expect(B11_SCENARIO.sessions.map(session => session.prompt)).toEqual(B11_PROMPTS);
    for (const prompt of B11_PROMPTS) {
      expect(prompt).not.toMatch(/\bmind\b/i);
      expect(prompt).not.toMatch(/\bengine\b/i);
    }
  });

  test('ships the fixture and asks for the 2 sessions', () => {
    expect(B11_SCENARIO.sessions).toHaveLength(2);
    expect(B11_SCENARIO.fixture).toMatch(/^fixtures\//);
  });
});

describe('B11 transcript parsing', () => {
  test('extracts direct tool calls and the skill id', () => {
    const calls = extractToolInvocations(passTranscript());
    expect(calls.map(call => call.name)).toEqual(['skill', 'mind_checkpoint_save']);
    expect(calls[0]!.input.id).toBe(B11_SKILL_ID);
    expect(calls[1]!.server).toBe('mind');
  });

  test('extracts code-mode nested tool calls without guessing inputs', () => {
    const raw = {
      data: [
        assistant(
          tool('execute', {}, [
            { tool: 'mind_checkpoint_save', args: { pending: B11_PENDING_ITEM } },
            { tool: 'mind_memory_add', args: {} },
          ])
        ),
      ],
    };
    const calls = extractToolInvocations(raw);
    expect(calls.map(call => call.name)).toEqual([
      'execute',
      'mind_checkpoint_save',
      'mind_memory_add',
    ]);
    expect(calls[1]!.input.pending).toBe(B11_PENDING_ITEM);
  });

  test('accepts a type:skill message as the skill evidence', () => {
    const analysis = analyzeTranscripts([
      session({ data: [skillMessage(), assistant(tool('mind_checkpoint_save', {}))] }),
    ]);
    expect(analysis[0]!.firstSkillIndex).toBe(0);
    expect(analysis[0]!.ordered).toBe(true);
    expect(analysis[0]!.skillArgsUnavailable).toBe(false);
  });

  test('reports skill args unavailable instead of inventing a load', () => {
    const analysis = analyzeTranscripts([session({ data: [assistant(tool('skill', {}))] })]);
    expect(analysis[0]!.firstSkillIndex).toBe(-1);
    expect(analysis[0]!.skillArgsUnavailable).toBe(true);
    expect(analysis[0]!.missingEvidence.join('\n')).toContain('no usable id');
  });

  test('never infers a skill load from the code-mode regex fallback', () => {
    const raw = {
      data: [
        assistant(
          tool('execute', {
            code: "tools.skill.load({ id: 'mind-management' }); tools.mind.memory_query({});",
          })
        ),
      ],
    };
    const analysis = analyzeTranscripts([session(raw)]);
    expect(analysis[0]!.firstSkillIndex).toBe(-1);
    expect(analysis[0]!.firstMindIndex).toBe(2);
    expect(analysis[0]!.ordered).toBe(false);
  });

  test('detects system_instructions only after the skill load', () => {
    const after = analyzeTranscripts([
      session({
        data: [
          assistant(tool('skill', { id: B11_SKILL_ID })),
          assistant(tool('mind_system_instructions', {})),
        ],
      }),
    ]);
    expect(after[0]!.systemInstructionsAfterSkill).toBe(true);

    const before = analyzeTranscripts([
      session({
        data: [
          assistant(tool('mind_system_instructions', {})),
          assistant(tool('skill', { id: B11_SKILL_ID })),
        ],
      }),
    ]);
    expect(before[0]!.systemInstructionsAfterSkill).toBe(false);
  });
});

describe('B11 assertion', () => {
  test('passes when both sessions load the skill before their first Mind call', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(true);
    const details = result.details.join('\n');
    expect(details).toContain('session 1:');
    expect(details).toContain('session 2:');
    expect(details).toContain('ordered');
    expect(details).toContain('still carries pending work');
  });

  test('Incomplete B11 evidence is not a skill-order failure', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [unavailableSessionResult(0), unavailableSessionResult(1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('harness error');
    expect(details).toContain('message evidence unavailable');
    expect(details).not.toContain('did not load');
    expect(details).not.toContain('called Mind before loading');
  });

  test('fails when session 1 calls Mind before loading the skill', async () => {
    const first = {
      data: [
        assistant(tool('mind_memory_query', {})),
        assistant(tool('skill', { id: B11_SKILL_ID })),
      ],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(first, 0), sessionResult(passTranscript(), 1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('session 1:');
    expect(details).toContain('called Mind before loading');
    expect(details).not.toContain('harness error');
  });

  test('fails when only session 1 loaded the skill and session 2 is Mind-only', async () => {
    const second = { data: [assistant(tool('mind_memory_query', {}))] };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(passTranscript(), 0), sessionResult(second, 1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('session 2:');
    expect(details).toContain('did not load');
  });

  test('fails when only session 2 loaded the skill and session 1 is Mind-only', async () => {
    const first = { data: [assistant(tool('mind_memory_query', {}))] };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(first, 0), sessionResult(passTranscript(), 1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('session 1:');
    expect(details).toContain('did not load');
  });

  test('fails when the same assistant message calls Mind before the skill', async () => {
    const first = {
      data: [assistant(tool('mind_checkpoint_save', {}), tool('skill', { id: B11_SKILL_ID }))],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(first, 0), sessionResult(passTranscript(), 1)],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('called Mind before loading');
  });

  test('passes when the skill precedes a nested code-mode Mind call in the same message', async () => {
    const first = {
      data: [
        assistant(
          tool('skill', { id: B11_SKILL_ID }),
          tool('execute', {}, [{ tool: 'mind_checkpoint_save', args: {} }])
        ),
      ],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(first, 0), sessionResult(passTranscript(), 1)],
      })
    );
    expect(result.pass).toBe(true);
  });

  test('fails when a skill tool call carries no usable id', async () => {
    const raw = {
      data: [assistant(tool('skill', {})), assistant(tool('mind_checkpoint_save', {}))],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(raw),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no usable id');
  });

  test('fails when the skill was not loaded', async () => {
    const raw = { data: [assistant(tool('mind_checkpoint_save', {}))] };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(raw),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('did not load');
  });

  test('fails when no Mind memory/checkpoint tool call happened', async () => {
    const raw = { data: [assistant(tool('skill', { id: B11_SKILL_ID }))] };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(raw),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('made no Mind call');
  });

  test('fails when system_instructions is called after the skill in one session', async () => {
    const second = {
      data: [
        assistant(tool('skill', { id: B11_SKILL_ID })),
        assistant(tool('mind_system_instructions', {})),
        assistant(tool('mind_checkpoint_save', {})),
      ],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(passTranscript(), 0), sessionResult(second, 1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('session 2:');
    expect(details).toContain('system_instructions after');
  });

  test('fails with an explicit reason when only one session result exists', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(passTranscript(), 0)],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('expected exactly 2 session results, got 1');
  });

  test('fails when a session status is not ok', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [
          sessionResult(passTranscript(), 0),
          sessionResult(passTranscript(), 1, 'error'),
        ],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain("session 2: status is 'error'");
  });

  test('fails with a harness error when a captured transcript has no usable events', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: [sessionResult(passTranscript(), 0), sessionResult({ data: [] }, 1)],
      })
    );
    const details = result.details.join('\n');
    expect(result.pass).toBe(false);
    expect(details).toContain('harness error: session 2');
    expect(details).toContain('no usable events');
    expect(details).not.toContain('did not load');
  });

  test('fails when the checkpoint was completed or deleted', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(null),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no active checkpoint');
  });

  test('fails when the checkpoint has no pending work', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(''),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('does not match');
  });

  test('fails when the resume artifact is missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bench-b11-noartifact-'));
    const result = await b11MakeAssertion(
      ctx(workspace, {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain(`${B11_ARTIFACT_FILE} was not written`);
  });

  test('fails when the resume artifact does not reflect the pending item', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bench-b11-badartifact-'));
    write(join(workspace, B11_ARTIFACT_FILE), 'Run the tests.\n');
    const result = await b11MakeAssertion(
      ctx(workspace, {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('does not reflect');
  });

  test('fails clearly when there is no Mind database', async () => {
    const result = await b11MakeAssertion(ctx(passWorkspace()));
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('no Mind database');
  });
});

describe('B11 fixture hygiene', () => {
  test('the fixture does not leak the pending item', () => {
    const root = join(HARNESS_ROOT, B11_SCENARIO.fixture);
    for (const relative of ['README.md', 'package.json', 'src/release.ts']) {
      const content = readFileSync(join(root, relative), 'utf8').toLowerCase();
      expect(content).not.toContain('release notes');
      expect(content).not.toContain('checkpoint');
    }
  });
});
