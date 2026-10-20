// Unit tests for scenario B11 (skill-first activation + pending-work continuity).
// Synthetic raw transcripts and temporary databases only: no OpenCode, no model.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { scenarioGateReason } from '../src/benchmarkB/runner';
import type { BSessionResult, ScenarioAssertionContext } from '../src/benchmarkB/scenario';
import {
  B11_ALLOWED_SKILLS,
  B11_ARTIFACT_FILE,
  B11_PENDING_ITEM,
  B11_PROMPTS,
  B11_SCENARIO,
  B11_SKILL_ID,
  addL2InstructionToEnv,
  analyzeTranscripts,
  extractToolInvocations,
  l2InstructionPath,
  makeAssertion as b11MakeAssertion,
} from '../src/benchmarkB/scenarios/b11/index';
import { SCENARIO_IDS } from '../src/benchmarkB/scenarios/registry';
import type { CommandRunner } from '../src/exec';

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

function session(rawMessages: unknown): Pick<BSessionResult, 'rawMessages'> {
  return { rawMessages };
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

function sessionResults(raw: unknown): BSessionResult[] {
  return [
    {
      status: 'ok',
      sessionId: 'ses_1',
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
      rawMessages: raw,
      sessionIndex: 0,
      prompt: B11_PROMPTS[0]!,
    },
  ];
}

describe('B11 registry and gating', () => {
  test('is registered after B10 and declares mind-memory without RAG', () => {
    expect(SCENARIO_IDS).toEqual(['b1', 'b4', 'b5', 'b6', 'b7', 'b9', 'b8', 'b10', 'b11']);
    expect(B11_SCENARIO.requires).toEqual(['mind-memory']);
    expect(B11_SCENARIO.rag).toBeUndefined();
    expect(B11_SCENARIO.fixture).toBe('fixtures/b11');
    expect(B11_SCENARIO.allowedSkills).toEqual(B11_ALLOWED_SKILLS);
    expect(B11_ALLOWED_SKILLS).toContain(B11_SKILL_ID);
  });

  test('gates not_run under no-memory instead of running a memory task', () => {
    expect(scenarioGateReason(B11_SCENARIO, 'no-memory', {})).toContain('Mind');
    expect(scenarioGateReason(B11_SCENARIO, 'mind-v9', {})).toBeNull();
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

  test('reports skill args unavailable instead of inventing a load', () => {
    const analysis = analyzeTranscripts([session({ data: [assistant(tool('skill', {}))] })]);
    expect(analysis.skillLoaded).toBe(false);
    expect(analysis.skillArgsUnavailable).toBe(true);
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
    expect(after.systemInstructionsAfterSkill).toBe(true);

    const before = analyzeTranscripts([
      session({
        data: [
          assistant(tool('mind_system_instructions', {})),
          assistant(tool('skill', { id: B11_SKILL_ID })),
        ],
      }),
    ]);
    expect(before.systemInstructionsAfterSkill).toBe(false);
  });
});

describe('B11 assertion', () => {
  test('passes with a skill load, mind call, pending checkpoint and artifact', async () => {
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(passTranscript()),
      })
    );
    expect(result.pass).toBe(true);
    expect(result.details.join('\n')).toContain(`loaded the '${B11_SKILL_ID}' skill`);
    expect(result.details.join('\n')).toContain('still carries pending work');
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
    expect(result.details.join('\n')).toContain('no Mind memory/checkpoint tool call');
  });

  test('fails when system_instructions is called after the skill load', async () => {
    const raw = {
      data: [
        assistant(tool('skill', { id: B11_SKILL_ID })),
        assistant(tool('mind_system_instructions', {})),
        assistant(tool('mind_checkpoint_save', {})),
      ],
    };
    const result = await b11MakeAssertion(
      ctx(passWorkspace(), {
        mindDb: createCheckpointDb(B11_PENDING_ITEM),
        sessionResults: sessionResults(raw),
      })
    );
    expect(result.pass).toBe(false);
    expect(result.details.join('\n')).toContain('system_instructions was called after');
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

describe('B11 seed', () => {
  test('runs real mind setup opencode in the isolated HOME and wires the L2 activation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bench-b11-home-'));
    const dbPath = join(mkdtempSync(join(tmpdir(), 'bench-b11-seed-')), 'mind.db');
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      MIND_DB_PATH: dbPath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'openrouter/x' }),
    };
    const calls: { command: string; args: readonly string[] }[] = [];
    await B11_SCENARIO.seed!({
      workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b11-seed-ws-')),
      mindDb: dbPath,
      mindBin: '/fake/mind',
      env,
      run: async invocation => {
        calls.push({ command: invocation.command, args: invocation.args });
        return {
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: '/fake/mind', args: ['setup', 'opencode'] });
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as { instructions: string[] };
    expect(parsed.instructions).toContain(l2InstructionPath(home));
  });

  test('addL2InstructionToEnv is idempotent and keeps existing instructions', () => {
    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['/existing.md'] }),
    };
    addL2InstructionToEnv(env, '/l2.md');
    addL2InstructionToEnv(env, '/l2.md');
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { instructions: string[] };
    expect(parsed.instructions).toEqual(['/l2.md', '/existing.md']);
  });

  test('seed fails clearly when setup exits non-zero', async () => {
    await expect(
      B11_SCENARIO.seed!({
        workspaceDir: mkdtempSync(join(tmpdir(), 'bench-b11-fail-')),
        mindDb: join(tmpdir(), 'x', 'mind.db'),
        mindBin: '/fake/mind',
        env: { HOME: '/tmp/isolated-b11' },
        run: async invocation => ({
          command: invocation.command,
          args: invocation.args,
          stdout: '',
          stderr: 'nope',
          exitCode: 1,
        }),
      })
    ).rejects.toThrow('setup opencode');
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
