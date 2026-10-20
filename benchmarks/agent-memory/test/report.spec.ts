// Report generator tests — section coverage, injected numbers, the secret
// scan and determinism, all against handcrafted fixtures.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { A2QuestionResult } from '../src/benchmarkA/judge';
import { assertNoSecrets, generateReport, runReport, SecretLeakError } from '../src/report';

import { makeA1, makeA2, makeMeta, makeScenario, writeFixtureRun } from './fixtures/bench-run';

function fullFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-report-'));
  writeFixtureRun(dir, {
    a1: { 'mind-v9': makeA1({ hitAt5: 0 }), 'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.5 }) },
    a2: {
      'no-memory': [makeA2('no-memory', 'conv-26#1', 'incorrect', { judgeScore: 0.1 })],
      'mind-v9': [makeA2('mind-v9', 'conv-26#1', 'partial', { judgeScore: 0.5, f1: 0.4 })],
      'mind-v10': [makeA2('mind-v10', 'conv-26#1', 'correct', { judgeScore: 0.9, f1: 0.8 })],
    },
    b: {
      'no-memory': [makeScenario('no-memory', 'b1', false)],
      'mind-v9': [makeScenario('mind-v9', 'b1', true, { memoryCalls: 2 })],
      'mind-v10': [makeScenario('mind-v10', 'b1', true, { memoryCalls: 3 })],
    },
  });
  return dir;
}

describe('generateReport sections', () => {
  test('emits every mandated section header and the conclusions', () => {
    const report = generateReport({ runDir: fullFixtureDir() });
    for (let n = 1; n <= 13; n++) {
      expect(report).toMatch(new RegExp(`^## ${n}\\. `, 'm'));
    }
    expect(report).toContain('## Conclusiones');
    expect(report).toContain('¿Mejora v10 respecto de v9?');
    expect(report).toContain('¿Aporta Mind frente a no usar memoria?');
  });

  test('injects the exact numbers from the run artifacts', () => {
    const report = generateReport({ runDir: fullFixtureDir() });
    // A1 hit@5 v10 = 0.500, v9 = 0.000.
    expect(report).toContain('0.500');
    // A2 judge: no-memory 0.100 → mind-v10 0.900.
    expect(report).toContain('0.100');
    expect(report).toContain('0.900');
    // SHA and model from meta.
    expect(report).toContain('2222222');
    expect(report).toContain('deepseek-v4.1-flash');
  });

  test('renders a not_run scenario with its reason instead of labeling it fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-notrun-'));
    writeFixtureRun(dir, {
      b: {
        'no-memory': [makeScenario('no-memory', 'b1', false)],
        'mind-v9': [makeScenario('mind-v9', 'b1', true)],
        'mind-v10': [
          makeScenario('mind-v10', 'b1', false, {
            status: 'not_run',
            notRunReason: 'requires mind-current',
          }),
        ],
      },
    });
    const report = generateReport({ runDir: dir });
    expect(report).toContain('| B | b1 | fail | pass | not_run (requires mind-current) |');
    expect(report).toContain('| mind-v10 | 0/0 | n/a | 1 |');
  });

  test('marks missing stages as not_run instead of inventing numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-a1-'));
    writeFixtureRun(dir, {
      a1: { 'mind-v9': makeA1({ hitAt5: 0 }), 'mind-v10': makeA1({ hitAt5: 0.5 }) },
    });
    const report = generateReport({ runDir: dir });
    expect(report).toContain('not_run');
    expect(report).toContain('Etapas no ejecutadas');
  });

  test('lists Mind-help examples for A2 and B when a mind condition wins', () => {
    const report = generateReport({ runDir: fullFixtureDir() });
    const helped = report.slice(report.indexOf('## 8.'), report.indexOf('## 9.'));
    expect(helped).toContain('conv-26#1');
    expect(helped).toContain('| A2 |');
    expect(helped).toContain('| B |');
  });

  test('is deterministic across two generations', () => {
    const dir = fullFixtureDir();
    expect(generateReport({ runDir: dir })).toBe(generateReport({ runDir: dir }));
  });
});

describe('section 12 limitations are fact-driven', () => {
  // The real 00008 run is the FULL 30-question subset with 3 repetitions per
  // (condition, question); only the B scenarios were absent. §12 must state
  // those facts instead of claiming the full run is still pending.
  function fullRunDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-full-'));
    const meta = makeMeta('run-full-20261018-000000');
    const reps = (condition: 'no-memory' | 'mind-v10', id: string): A2QuestionResult[] =>
      [0, 1, 2].map(rep =>
        makeA2(condition, id, 'correct', { judgeScore: rep === 0 ? 1 : 0.5, f1: 0.5, rep })
      );
    writeFixtureRun(dir, {
      meta: { ...meta, subset: { ...meta.subset, count: 30 } },
      a1: { 'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.4 }) },
      a2: {
        'no-memory': reps('no-memory', 'conv-26#1'),
        'mind-v10': reps('mind-v10', 'conv-26#1'),
      },
    });
    return dir;
  }

  test('does not claim the full run is pending when reps=3 and the full subset ran', () => {
    const report = generateReport({ runDir: fullRunDir() });
    const s12 = report.slice(report.indexOf('## 12.'), report.indexOf('## 13.'));
    expect(s12).not.toContain('corrida completa');
    expect(s12).not.toContain('una iteración posterior');
    expect(s12).not.toContain('Piloto de una sola corrida');
    expect(s12).toContain('30 preguntas');
    expect(s12).toContain('3 rep');
    // Conditions/stages that did not run are named explicitly.
    expect(s12).toContain('mind-v9');
    expect(s12).toContain('Etapas no ejecutadas: b');
  });

  test('states the single-session variance limitation without calling the run a pilot', () => {
    const report = generateReport({ runDir: fullRunDir() });
    expect(report).not.toContain('piloto');
    expect(report).toContain('Una sola corrida');
  });

  test('a reduced pilot subset reports its true size, not the full protocol', () => {
    const report = generateReport({ runDir: fullFixtureDir() });
    const s12 = report.slice(report.indexOf('## 12.'), report.indexOf('## 13.'));
    expect(s12).toContain('5 preguntas');
    expect(s12).not.toContain('30 preguntas');
  });
});

describe('secret scan', () => {
  test('rejects home paths, keys and bearer tokens', () => {
    expect(() => assertNoSecrets('path is /home/someone/secret')).toThrow(SecretLeakError);
    expect(() => assertNoSecrets('key sk-abcdefghijklmnop')).toThrow(SecretLeakError);
    expect(() => assertNoSecrets('Authorization: Bearer abcdefghijklmnop')).toThrow(
      SecretLeakError
    );
    expect(() => assertNoSecrets('a plan and some prose only')).not.toThrow();
  });

  test('generateReport refuses a run whose artifacts leak a home path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-leak-'));
    writeFixtureRun(dir, {
      a2: {
        'mind-v10': [makeA2('mind-v10', 'q1', 'error', { error: 'crashed at /home/user/db' })],
      },
    });
    expect(() => generateReport({ runDir: dir })).toThrow(SecretLeakError);
  });
});

describe('runReport command', () => {
  test('writes REPORT.md and returns 0', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-report-repo-'));
    const runsRoot = join(repoRoot, 'runs');
    const runId = 'run-test';
    const dest = join(runsRoot, runId);
    // Re-home the fixture under a repo-relative runs root.
    writeFixtureRun(dest, {
      a1: { 'mind-v9': makeA1({ hitAt5: 0 }), 'mind-v10': makeA1({ hitAt5: 0.5 }) },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = runReport(
      { runId, runsRoot: 'runs', outPath: 'benchmarks/agent-memory/REPORT.md' },
      { repoRoot, stdout: line => out.push(line), stderr: line => err.push(line) }
    );
    expect(code).toBe(0);
    const written = readFileSync(join(repoRoot, 'benchmarks/agent-memory/REPORT.md'), 'utf8');
    expect(written).toContain('## 1.');
    expect(out.join('\n')).toContain('wrote');
  });

  test('returns 1 when the run does not exist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-report-missing-'));
    const err: string[] = [];
    const code = runReport(
      { runId: 'nope', runsRoot: 'runs', outPath: 'out.md' },
      { repoRoot, stdout: () => undefined, stderr: line => err.push(line) }
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('not found');
  });
});

describe('report isolation evidence', () => {
  test('summarises persisted isolation-evidence dumps', () => {
    const dir = fullFixtureDir();
    const evidenceDir = join(dir, 'a2', 'mind-v10', 'conv-26_1', 'isolation-evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'summary.txt'), 'debug-paths: exit=0\ndebug-config: exit=0\n');
    writeFileSync(join(evidenceDir, 'debug-paths.stdout.txt'), 'x');
    const report = generateReport({ runDir: dir });
    expect(report).toContain('isolation-evidence');
    // Two files: one dump + summary.txt (the report must not label the check
    // count as "dump files").
    expect(report).toContain('2 archivos: 1 dumps + `summary.txt`');
  });
});
