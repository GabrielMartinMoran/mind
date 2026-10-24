// Report generator tests — section coverage, injected numbers, the secret
// scan and determinism, all against handcrafted fixtures.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { A2QuestionResult } from '../src/benchmarkA/judge';
import { loadRunSummary } from '../src/metrics/aggregate';
import {
  assertNoSecrets,
  buildCuratedPerQuestion,
  generateReport,
  runReport,
  SecretLeakError,
} from '../src/report';

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

  test('renders abstention, empty answers and incomplete runs as separate outcomes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-outcomes-'));
    writeFixtureRun(dir, {
      a2: {
        'mind-v10': [
          makeA2('mind-v10', 'q1', 'abstention'),
          makeA2('mind-v10', 'q2', 'empty_answer'),
          makeA2('mind-v10', 'q3', 'incomplete', { error: 'idle outcome failed' }),
        ],
      },
    });
    const report = generateReport({ runDir: dir });
    expect(report).toContain('| empty | incomplete |');
    expect(report).toContain('Ejecuciones A2 incompletas');
    // Section 7 lists an incomplete run once, in the incomplete section only.
    expect(report.split('mind-v10/q3').length - 1).toBe(1);
    // Deterministic F1 and the blind-judge score stay separately labelled.
    expect(report).toContain('F1 det.');
    expect(report).toContain('juez ciego');
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

describe('measured-condition reports', () => {
  function withCurrent(meta = makeMeta()): ReturnType<typeof makeMeta> {
    return {
      ...meta,
      current: {
        branch: 'feat/test-branch',
        headSha: 'abc1234',
        dirty: false,
        packageVersion: '0.1.0-test',
        schemaVersion: 10,
        mindBinary: '/opt/mind/mind',
      },
    };
  }

  test('a no-memory + mind-current run renders measured baseline deltas only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-baseline-'));
    writeFixtureRun(dir, {
      meta: withCurrent(),
      a1: { 'mind-current': makeA1({ hitAt5: 0.6, mrr: 0.35 }) },
      a2: {
        'no-memory': [makeA2('no-memory', 'conv-26#1', 'incorrect', { judgeScore: 0.1, f1: 0.3 })],
        'mind-current': [
          makeA2('mind-current', 'conv-26#1', 'correct', { judgeScore: 0.9, f1: 0.8 }),
        ],
      },
      b: {
        'no-memory': [makeScenario('no-memory', 'b1', false)],
        'mind-current': [makeScenario('mind-current', 'b1', true)],
      },
    });
    const report = generateReport({ runDir: dir });
    expect(report).toContain('### Delta vs baseline (no-memory)');
    expect(report).toContain(
      '| mind-current | overall | judgeScoreMean | 0.100 | 0.900 | +0.800 |'
    );
    expect(report).toContain('| a2.judgeScoreMean | 0.100 | 0.900 |');
    // The baseline is measured, so the report must not deny every comparison:
    // it only says there is no pairwise Mind-vs-Mind comparison.
    expect(report).toContain(
      'No se seleccionó una comparación pairwise entre condiciones Mind; se muestra el baseline `no-memory`.'
    );
    expect(report).not.toContain(
      'No se seleccionó una comparación entre condiciones en esta corrida.'
    );
    expect(report).not.toContain('mind-v9');
    expect(report).not.toContain('mind-v10');
    expect(report).not.toContain('A1 no ejecutado');
    // No historical v9↔v10 question or claim when neither side was measured.
    expect(report).not.toContain('¿Mejora v10 respecto de v9?');
    expect(report).toContain('¿Cómo se comparan las condiciones medidas?');
    expect(report).not.toContain('es la comparación pedida');
    // §6 must not deny every comparison when the measured baseline is shown.
    const section6 = report.slice(report.indexOf('## 6.'), report.indexOf('## 7.'));
    expect(section6).toContain(
      'No se seleccionó una comparación pairwise entre condiciones Mind; se muestra el baseline `no-memory`.'
    );
    expect(section6).not.toContain('el informe es absoluto para las condiciones medidas');
    expect(report).not.toContain('el informe es absoluto para las condiciones medidas');
  });

  test('v9 + v10 + current renders measured pairwise comparisons and keeps the legacy diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-pairwise-'));
    writeFixtureRun(dir, {
      meta: withCurrent(),
      a1: {
        'mind-v9': makeA1({ hitAt5: 0 }),
        'mind-v10': makeA1({ hitAt5: 0.5 }),
        'mind-current': makeA1({ hitAt5: 0.75 }),
      },
      a2: {
        'no-memory': [makeA2('no-memory', 'conv-26#1', 'incorrect', { judgeScore: 0.1 })],
        'mind-v9': [makeA2('mind-v9', 'conv-26#1', 'partial', { judgeScore: 0.5 })],
        'mind-v10': [makeA2('mind-v10', 'conv-26#1', 'correct', { judgeScore: 0.9 })],
        'mind-current': [makeA2('mind-current', 'conv-26#1', 'correct', { judgeScore: 0.95 })],
      },
      b: {
        'no-memory': [makeScenario('no-memory', 'b1', false)],
        'mind-v9': [makeScenario('mind-v9', 'b1', true)],
        'mind-v10': [makeScenario('mind-v10', 'b1', true)],
        'mind-current': [makeScenario('mind-current', 'b1', true)],
      },
    });
    const report = generateReport({ runDir: dir });
    // Measured-only pairwise comparisons in deterministic order.
    expect(report).toContain('| mind-v9 → mind-v10 |');
    expect(report).toContain('| mind-v9 → mind-current |');
    expect(report).toContain('| mind-v10 → mind-current |');
    // The legacy v9↔v10 diff remains available, with its historical question
    // and caveat only because both historical conditions were measured.
    expect(report).toContain('### Diffs v9 → v10');
    expect(report).toContain('¿Mejora v10 respecto de v9?');
    expect(report).toContain('comparación histórica seleccionada');
    // Examples use the active conditions, not a fixed v9/v10/no-memory triple.
    expect(report).toContain('| benchmark | id | no-memory | mind-v9 | mind-v10 | mind-current |');
    // Per-question appendix columns follow the active conditions.
    expect(report).toContain('mind-current (clase/juez)');
  });

  test('rejects an empty run with an actionable error instead of an all-n/a report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-empty-'));
    writeFixtureRun(dir, {});
    expect(() => generateReport({ runDir: dir })).toThrow(/no measured conditions/i);
  });

  test('runReport fails and writes nothing for an empty run', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-report-empty-repo-'));
    writeFixtureRun(join(repoRoot, 'runs', 'run-empty'), {});
    const err: string[] = [];
    const code = runReport(
      { runId: 'run-empty', runsRoot: 'runs', outPath: 'REPORT.md' },
      { repoRoot, stdout: () => undefined, stderr: line => err.push(line) }
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no measured conditions');
    expect(existsSync(join(repoRoot, 'REPORT.md'))).toBe(false);
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

describe('judge scores exclude non-judgeable results everywhere', () => {
  // Contract 3: an empty/incomplete answer never receives a positive blind-judge
  // score. A stale judge score left on such a result must not re-enter the
  // report appendix or the curated export while the summary already excludes it.
  function staleJudgeFixture(): A2QuestionResult[] {
    return [
      makeA2('mind-v10', 'conv-26#1', 'correct', { judgeScore: 0.9, f1: 0.8, rep: 0 }),
      {
        ...makeA2('mind-v10', 'conv-26#1', 'empty_answer', { judgeScore: 0.1, rep: 1 }),
        answer: '',
      },
    ];
  }

  test('per-question appendix mean matches the summary mean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-judgeable-'));
    writeFixtureRun(dir, { a2: { 'mind-v10': staleJudgeFixture() } });

    const summaryMean = loadRunSummary(dir).conditions['mind-v10']?.a2?.judgeScoreMean ?? null;
    expect(summaryMean).toBeCloseTo(0.9, 6);

    const report = generateReport({ runDir: dir });
    const appendix = report.slice(report.indexOf('## Anexo'));
    const row = appendix.split('\n').find(line => line.startsWith('| conv-26#1 |'));
    expect(row).toBeDefined();
    // The stale 0.1 on the empty_answer rep must not drag the appendix down.
    expect(row).toContain(`${summaryMean!.toFixed(3)}`);
    expect(row).not.toContain('0.500');
  });

  test('curated export omits judge scores for empty answers but keeps judgeable ones', () => {
    const results = staleJudgeFixture();
    // A judgeable result that carries an error is still an answer measurement.
    results.push(
      makeA2('mind-v10', 'conv-26#1', 'partial', {
        judgeScore: 0.7,
        rep: 2,
        error: 'post-answer warning',
      })
    );

    const entry = buildCuratedPerQuestion({ 'mind-v10': results }).find(
      item => item.id === 'conv-26#1'
    );
    expect(entry).toBeDefined();
    const reps = entry?.conditions['mind-v10'] ?? [];
    const byRep = new Map(reps.map(rep => [rep.rep, rep]));

    expect(byRep.get(0)?.judgeScore).toBe(0.9);
    expect(byRep.get(1)?.judgeScore).toBeNull();
    expect(byRep.get(2)?.judgeScore).toBe(0.7);
    // Non-judge fields stay untouched for the excluded rep.
    expect(byRep.get(1)?.class).toBe('empty_answer');
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
