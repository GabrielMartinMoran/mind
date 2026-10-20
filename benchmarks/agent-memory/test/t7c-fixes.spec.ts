// T7c regression tests: the MCP warm-up retry, write-time secret redaction,
// tool-version capture and judge-cost accumulation.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { A2UnitJob } from '../src/benchmarkA/a2';
import { runA2Command, withBudgetSpent } from '../src/benchmarkA/command';
import type { A2QuestionResult } from '../src/benchmarkA/judge';
import type { ConditionId } from '../src/config';
import type { CommandInvocation } from '../src/exec';
import { isolationDirs } from '../src/isolation/opencode';
import { ContaminationError, verifyIsolation } from '../src/isolation/verify';
import { createProcessExecutor } from '../src/opencode/executor';
import { REDACTED, redactEnv, stripRedacted } from '../src/redact';
import type { RunMeta } from '../src/run';
import {
  createFakeRunner,
  createFakeSessionDriver,
  type FakeCommandResolver,
} from '../src/testing/fakes';
import {
  HARNESS_ROOT,
  captureToolVersions,
  parseOpencodeVersion,
  readSdkVersion,
} from '../src/versions';

// ── (a) mcp-list warm-up retry ───────────────────────────────────────────────

const conditionDir = mkdtempSync(join(tmpdir(), 'bench-t7c-verify-'));
const dir = isolationDirs(conditionDir);
const env = { HOME: dir.home, XDG_CONFIG_HOME: dir.config };
const noSleep = async (): Promise<void> => undefined;

function mindResolver(mcpOutputs: string[]): FakeCommandResolver {
  let call = 0;
  return inv => {
    const key = inv.args.join(' ');
    if (key === 'debug paths')
      return {
        stdout: (['home', 'config', 'state'] as const).map(k => `${k} ${dir[k]}`).join('\n'),
      };
    if (key === 'debug config')
      return {
        stdout: JSON.stringify([
          {
            type: 'document',
            info: {
              model: { providerID: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
              mcp: { servers: { mind: { type: 'local', command: ['/x/mind', 'mcp'] } } },
            },
          },
        ]),
      };
    if (key === 'mcp list') {
      const out = mcpOutputs[Math.min(call, mcpOutputs.length - 1)] ?? '';
      call += 1;
      return { stdout: out };
    }
    if (key === 'session list --format json') return { stdout: '[]' };
    if (key === 'api get /api/skill') return { stdout: '{"data":[{"id":"opencode"}]}' };
    return { stdout: '{"data":[]}' };
  };
}

async function verifyMind(resolver: FakeCommandResolver) {
  const fake = createFakeRunner(resolver);
  return verifyIsolation({
    condition: 'mind-v10',
    dir,
    env,
    runner: fake.runner,
    evidenceDir: mkdtempSync(join(tmpdir(), 'bench-t7c-evid-')),
    sleep: noSleep,
  });
}

describe('mcp-list warm-up retry', () => {
  test('passes when mind appears only after a warm-up attempt', async () => {
    const report = await verifyMind(
      mindResolver(['No MCP servers configured\n', 'mind  pending\n'])
    );
    expect(report.ok).toBe(true);
  });

  test('fails closed when mind never appears', async () => {
    await expect(verifyMind(mindResolver(['No MCP servers configured\n']))).rejects.toThrow(
      ContaminationError
    );
  });
});

// ── (b) write-time redaction ─────────────────────────────────────────────────

describe('redaction', () => {
  test('redactEnv replaces secret-looking values and stripRedacted drops them', () => {
    const envMap = { OPENROUTER_API_KEY: 'not-a-real-key-value', HOME: '/tmp/h', PATH: '/bin' };
    const redacted = redactEnv(envMap);
    expect(redacted.OPENROUTER_API_KEY).toBe(REDACTED);
    expect(redacted.HOME).toBe('/tmp/h');
    expect(stripRedacted(redacted)).toEqual({ HOME: '/tmp/h', PATH: '/bin' });
  });

  test('executor never writes the real credential into job.json', async () => {
    const unitDir = mkdtempSync(join(tmpdir(), 'bench-t7c-job-'));
    const job: A2UnitJob = {
      runId: 'r',
      condition: 'mind-v10' as ConditionId,
      questionId: 'q1',
      adversarial: false,
      prompt: 'p',
      workspaceDir: unitDir,
      conditionDir: unitDir,
      unitDir,
      evidenceDir: join(unitDir, 'ev'),
      limits: { steps: 1, timeoutMs: 1000 },
      env: { OPENROUTER_API_KEY: 'not-a-real-key-value', HOME: '/tmp/h' },
      mindDbPath: null,
      mindBin: null,
    };
    const seen: string[] = [];
    const executor = createProcessExecutor({
      runner: async (inv: CommandInvocation) => {
        // args = ['run', workerPath, jobPath]
        seen.push(readFileSync(inv.args[2]!, 'utf8'));
        return { ...inv, stdout: '', stderr: '', exitCode: 0 };
      },
      workerPath: '/tmp/worker.ts',
    });
    await executor(job);
    const written = JSON.parse(seen[0]!) as { env: Record<string, string> };
    expect(written.env.OPENROUTER_API_KEY).toBe(REDACTED);
    expect(JSON.stringify(written)).not.toContain('not-a-real-key-value');
  });
});

// ── (c) version capture ──────────────────────────────────────────────────────

describe('captureToolVersions', () => {
  test('parses opencode --version and reads the harness sdk + bun', async () => {
    expect(parseOpencodeVersion('opencode v2.0.28')).toBe('2.0.28');

    // A synthetic harness root proves the SDK is read from the given root...
    const harness = mkdtempSync(join(tmpdir(), 'bench-t7c-harness-'));
    mkdirSync(join(harness, 'node_modules/@opencode/sdk'), { recursive: true });
    writeFileSync(
      join(harness, 'node_modules/@opencode/sdk/package.json'),
      '{"name":"@opencode/sdk","version":"9.9.9"}\n'
    );
    expect(readSdkVersion(harness)).toBe('9.9.9');
    expect(readSdkVersion(join(harness, 'missing'))).toBeNull();

    // ...and that a run with no explicit sdkRoot resolves the harness root (the
    // subproject), never the repository root.
    expect(HARNESS_ROOT.endsWith(join('benchmarks', 'agent-memory'))).toBe(true);
    expect(readSdkVersion()).toBe('2.0.28');

    const { runner } = createFakeRunner(inv =>
      inv.args.includes('--version') ? { stdout: 'opencode v2.0.28\n' } : undefined
    );
    const versions = await captureToolVersions(runner, { repoRoot: harness, sdkRoot: harness });
    expect(versions.opencode).toBe('2.0.28');
    expect(versions.sdk).toBe('9.9.9');
    expect(versions.bun).toBe(Bun.version);

    const harnessVersions = await captureToolVersions(runner, { repoRoot: harness });
    expect(harnessVersions.sdk).toBe('2.0.28');
  });
});

// ── (d) judge cost accumulation ──────────────────────────────────────────────

describe('withBudgetSpent', () => {
  test('accumulates onto existing spend and keeps the cap', () => {
    const meta = {
      budget: { maxCostUsd: 5, spentUsd: 0.01 },
    } as unknown as RunMeta;
    expect(withBudgetSpent(meta, null, 0.002).budget).toEqual({
      maxCostUsd: 5,
      spentUsd: 0.012,
    });
  });
});

describe('judge cost is persisted', () => {
  function setupRun(): { runDir: string; repoRoot: string; runsRoot: string } {
    const root = mkdtempSync(join(tmpdir(), 'bench-t7c-a2-'));
    const runsRoot = join(root, 'runs');
    const runDir = join(runsRoot, 'run-x');
    mkdirSync(join(runDir, 'results'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify({
        runId: 'run-x',
        stages: {},
        limits: { sessionSteps: 1, timeoutMs: 1000 },
        budget: { maxCostUsd: 0, spentUsd: 0 },
        versions: { opencode: '2.0.28', sdk: '2.0.28', bun: '1.3.14' },
      })}\n`,
      'utf8'
    );
    const subset = [
      { id: 'q1', question: 'q?', answer: 'a', adversarial: false },
      { id: 'q2', question: 'q2?', answer: null, adversarial: true },
    ];
    writeFileSync(join(runDir, 'subset.json'), `${JSON.stringify({ items: subset })}\n`, 'utf8');
    const results: A2QuestionResult[] = [
      {
        id: 'q1',
        category: 1,
        categoryName: 'multi-hop',
        adversarial: false,
        condition: 'mind-v10' as ConditionId,
        answer: 'a',
        reference: 'a',
        deterministic: { klass: 'correct', f1: 1, abstained: false },
        judge: null,
        memoryCalls: 0,
        tokens: null,
        costUsd: 0,
        latencyMs: 1,
        error: null,
      },
      {
        id: 'q2',
        category: 5,
        categoryName: 'adversarial',
        adversarial: true,
        condition: 'mind-v10' as ConditionId,
        answer: 'no information available',
        reference: null,
        deterministic: { klass: 'correct_abstention', f1: null, abstained: true },
        judge: null,
        memoryCalls: 0,
        tokens: null,
        costUsd: 0,
        latencyMs: 1,
        error: null,
      },
    ];
    writeFileSync(
      join(runDir, 'results', 'a2-mind-v10.json'),
      `${JSON.stringify(results)}\n`,
      'utf8'
    );
    return { runDir, repoRoot: root, runsRoot: 'runs' };
  }

  test('accumulates A2 + judge spend into meta.budget.spentUsd', async () => {
    const { runDir, repoRoot, runsRoot } = setupRun();
    // Two questions -> two judge prompts, each costing $0.001.
    const driver = createFakeSessionDriver([
      { text: '{"verdicts":[{"candidate":1,"class":"correct","score":1}]}', cost: 0.001 },
      {
        text: '{"verdicts":[{"candidate":1,"class":"correct_abstention","score":1}]}',
        cost: 0.001,
      },
    ]);
    const code = await runA2Command(
      {
        runId: 'run-x',
        runsRoot,
        workRoot: 'work',
        conditions: ['mind-v10'],
        budgetUsd: 5,
        judgeOnly: true,
      },
      {
        repoRoot,
        runner: async inv => ({ ...inv, stdout: '', stderr: '', exitCode: 0 }),
        stdout: () => undefined,
        stderr: () => undefined,
        judgeDriver: driver,
        judgeProfile: { workspaceDir: '/tmp/ws', env: {} },
      }
    );
    expect(code).toBe(0);
    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as RunMeta;
    expect(meta.budget.spentUsd).toBeCloseTo(0.002, 6);
    expect(meta.budget.maxCostUsd).toBe(5);
    expect(meta.stages['judge:start']!.note).toContain('$0.0020');
  });
});
