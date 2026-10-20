// T8a report restyle + curated export tests (offline fixtures).

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { A2QuestionResult } from '../src/benchmarkA/judge';
import {
  buildCuratedPerQuestion,
  exportCuratedResults,
  generateReport,
  runReport,
} from '../src/report';

import { makeA1, makeA2, makeMeta, writeFixtureRun } from './fixtures/bench-run';

function a2(
  condition: 'no-memory' | 'mind-v9' | 'mind-v10',
  id: string,
  category: number,
  opts: {
    klass?: A2QuestionResult['deterministic']['klass'];
    judgeScore?: number | null;
    rep?: number;
  } = {}
): A2QuestionResult {
  const klass = opts.klass ?? 'correct';
  const base = makeA2(condition, id, klass, { judgeScore: opts.judgeScore ?? null });
  const categoryName =
    { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' }[
      category
    ] ?? 'unknown';
  return {
    ...base,
    category,
    categoryName,
    adversarial: category === 5,
    rep: opts.rep ?? 0,
  };
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-report-'));
  const make = (condition: 'no-memory' | 'mind-v9' | 'mind-v10'): A2QuestionResult[] => [
    a2(condition, 'conv-26#1', 1, { judgeScore: condition === 'mind-v10' ? 1 : 0 }),
    a2(condition, 'conv-26#5', 5, {
      klass: condition === 'mind-v10' ? 'correct_abstention' : 'hallucination',
      judgeScore: condition === 'mind-v10' ? 1 : 0,
    }),
  ];
  writeFixtureRun(dir, {
    meta: makeMeta('run-t8a-report'),
    a2: {
      'no-memory': make('no-memory'),
      'mind-v9': make('mind-v9'),
      'mind-v10': make('mind-v10'),
    },
  });
  return dir;
}

describe('report restyle', () => {
  test('emits the repo-style header, evidence legend and protocol section', () => {
    const report = generateReport({ runDir: fixtureDir() });
    expect(report).toContain('Informe técnico — Benchmark de memoria para agentes (00008)');
    expect(report).toContain('**Feature:** `00008-agent-memory-benchmark`');
    expect(report).toContain('**Run ID:**');
    expect(report).toContain('## Etiquetas de evidencia');
    expect(report).toContain('`[MEDIDO]`');
    expect(report).toContain('`[CALCULADO]`');
    expect(report).toContain('`[CÓDIGO]`');
    expect(report).toContain('## Protocolo y comparabilidad');
    expect(report).toMatch(/no deben\s+mezclarse|No deben\s+mezclarse|no.*mezclarse/i);
  });

  test('adds the per-category table, baseline-delta table and per-question appendix', () => {
    const report = generateReport({ runDir: fixtureDir() });
    expect(report).toContain('A2 por categoría');
    expect(report).toContain('multi-hop');
    expect(report).toContain('adversarial');
    expect(report).toContain('Delta vs baseline (no-memory)');
    expect(report).toContain('Anexo — por pregunta');
    expect(report).toContain('conv-26#1');
    // The 13 numbered sections and conclusions survive the restyle.
    for (let n = 1; n <= 13; n++) expect(report).toMatch(new RegExp(`^## ${n}\\. `, 'm'));
    expect(report).toContain('## Conclusiones');
  });

  test('rejects an OpenRouter-style key in the secret scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-leak-'));
    writeFixtureRun(dir, {
      a2: {
        'mind-v10': [
          a2('mind-v10', 'q1', 1, { judgeScore: 1 }),
          { ...makeA2('mind-v10', 'q2', 'error', { error: 'key sk-or-v1-abcdefghijklmnop' }) },
        ],
      },
    });
    expect(() => generateReport({ runDir: dir })).toThrow();
  });

  test('is deterministic', () => {
    const dir = fixtureDir();
    expect(generateReport({ runDir: dir })).toBe(generateReport({ runDir: dir }));
  });
});

describe('conclusions #1 is data-driven', () => {
  test('only says the v9↔v10 comparison is absent when v9 did not run but v10 did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-concl-v10-'));
    writeFixtureRun(dir, {
      meta: makeMeta('run-only-v10'),
      a1: { 'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.4 }) },
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1 })] },
    });
    const report = generateReport({ runDir: dir });
    const conclusions = report.slice(report.indexOf('## Conclusiones'));
    expect(conclusions).not.toContain('A1 no ejecutado');
    expect(conclusions).not.toContain('A2 no ejecutado');
    expect(conclusions).toContain('comparación v9↔v10 no disponible');
    expect(conclusions).toContain('v9 no ejecutó A1');
    expect(conclusions).toContain('mind-v9 no ejecutó A2');
    expect(conclusions).toContain('mind-v10');
  });

  test('states the direct A1 and A2 comparison when both v9 and v10 ran', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-concl-both-'));
    writeFixtureRun(dir, {
      meta: makeMeta('run-both'),
      a1: {
        'mind-v9': makeA1({ hitAt5: 0, mrr: 0.1 }),
        'mind-v10': makeA1({ hitAt5: 0.5, mrr: 0.4 }),
      },
      a2: {
        'mind-v9': [a2('mind-v9', 'q1', 1, { judgeScore: 0.2 })],
        'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1 })],
      },
    });
    const report = generateReport({ runDir: dir });
    const conclusions = report.slice(report.indexOf('## Conclusiones'));
    expect(conclusions).toContain('A1 hit@5: v9=0.000 vs v10=0.500');
    expect(conclusions).toContain('A2 judge: 0.200 → 1.000');
    expect(conclusions).not.toContain('comparación v9↔v10 no disponible');
  });
});

describe('section 11 costs', () => {
  test('reports judge cost and total run spend from meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-cost-'));
    const meta = makeMeta('run-cost');
    writeFixtureRun(dir, {
      meta: {
        ...meta,
        budget: { maxCostUsd: 5, spentUsd: 0.2312273576 },
        stages: {
          'judge:start': {
            status: 'passed',
            updatedAt: meta.updatedAt,
            note: '90 prompts, $0.0487, 0 manual',
          },
        },
      },
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1 })] },
    });
    const report = generateReport({ runDir: dir });
    const s11 = report.slice(report.indexOf('## 11.'), report.indexOf('## 12.'));
    expect(s11).toContain('Juez (LLM ciego):** $0.0487');
    expect(s11).toContain('Gasto total de la corrida:** $0.2312 de $5.00 de tope');
  });

  test('renders n/a for the judge cost when the judge stage note is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-t8a-cost-na-'));
    writeFixtureRun(dir, {
      meta: makeMeta('run-no-judge'),
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1 })] },
    });
    const report = generateReport({ runDir: dir });
    const s11 = report.slice(report.indexOf('## 11.'), report.indexOf('## 12.'));
    expect(s11).toContain('Juez (LLM ciego):** n/a');
    expect(s11).toContain('Gasto total de la corrida:** $0.0000');
  });
});

describe('curated export', () => {
  test('buildCuratedPerQuestion groups per question/condition with reps', () => {
    const curated = buildCuratedPerQuestion({
      'mind-v10': [
        a2('mind-v10', 'q1', 1, { rep: 0, judgeScore: 1 }),
        a2('mind-v10', 'q1', 1, { rep: 1, judgeScore: 0.5 }),
      ],
      'no-memory': [a2('no-memory', 'q1', 1, { rep: 0, judgeScore: 0 })],
    });
    expect(curated).toHaveLength(1);
    expect(curated[0]!.id).toBe('q1');
    expect(curated[0]!.conditions['mind-v10']).toHaveLength(2);
    expect(curated[0]!.conditions['mind-v10']![1]!.rep).toBe(1);
    expect(curated[0]!.conditions['no-memory']).toHaveLength(1);
  });

  test('labels a category-5 reference as an adversarial_answer', () => {
    const curated = buildCuratedPerQuestion({
      'mind-v10': [
        a2('mind-v10', 'q1', 1),
        a2('mind-v10', 'q5', 5, { klass: 'correct_abstention' }),
      ],
    });
    const cat1 = curated.find(entry => entry.id === 'q1')!;
    const cat5 = curated.find(entry => entry.id === 'q5')!;
    expect(cat1.referenceKind).toBe('answer');
    expect(cat5.referenceKind).toBe('adversarial_answer');
    // The value itself is preserved.
    expect(cat5.reference).toBe('ref');
  });

  test('writes summary.json + per-question.json outside runs/', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-t8a-export-'));
    const runDir = join(repoRoot, 'runs', 'run-x');
    writeFixtureRun(runDir, {
      meta: makeMeta('run-x'),
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1, rep: 0 })] },
    });
    const exportRoot = join(repoRoot, 'benchmarks', 'agent-memory', 'results');
    const result = exportCuratedResults(runDir, 'run-x', exportRoot);
    expect(existsSync(result.summaryPath)).toBe(true);
    expect(existsSync(result.perQuestionPath)).toBe(true);
    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf8'));
    expect(summary.runId).toBe('run-x');
    expect(summary.conditions['mind-v10'].a2).not.toBeNull();
    const perQuestion = JSON.parse(readFileSync(result.perQuestionPath, 'utf8'));
    expect(perQuestion[0].conditions['mind-v10'][0].rep).toBe(0);
  });

  test('sanitizes a real absolute run path and still rejects planted secrets', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-t8a-sanitize-'));
    const runDir = join(repoRoot, 'runs', 'run-home');
    const meta = makeMeta('run-home');
    // Simulate a REAL run whose meta records absolute paths (run dir prefix +
    // a bare /home path elsewhere).
    const realMeta = {
      ...meta,
      artifacts: {
        root: runDir,
        results: join(runDir, 'results'),
        conditions: {
          'no-memory': join(runDir, 'no-memory'),
          'mind-v9': join(runDir, 'mind-v9'),
          'mind-v10': join(runDir, 'mind-v10'),
          'mind-current': join(runDir, 'mind-current'),
        },
      },
      dataset: { url: 'file:///home/user/private/locomo.json', sha256: meta.dataset.sha256 },
    };
    writeFixtureRun(runDir, {
      meta: realMeta,
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1, { judgeScore: 1, rep: 0 })] },
    });
    const exportRoot = join(repoRoot, 'benchmarks', 'agent-memory', 'results');
    // Must NOT throw despite the /home paths in meta.
    const result = exportCuratedResults(runDir, 'run-home', exportRoot);
    const summaryText = readFileSync(result.summaryPath, 'utf8');
    expect(summaryText).not.toMatch(/\/home\//);
    expect(summaryText).toContain('<run>');

    // A planted REAL secret still fails closed.
    const leakDir = join(repoRoot, 'runs', 'run-leak');
    const leakMeta = makeMeta('run-leak');
    writeFixtureRun(leakDir, {
      meta: {
        ...leakMeta,
        dataset: { url: 'https://example.test/locomo?key=sk-or-v1-abcdefghijklmnop', sha256: null },
      },
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1)] },
    });
    expect(() => exportCuratedResults(leakDir, 'run-leak', exportRoot)).toThrow();
  });

  test('renderHeader marks v9 as not executed only when it did not run', () => {
    const onlyV10 = mkdtempSync(join(tmpdir(), 'bench-t8a-hdr-'));
    writeFixtureRun(onlyV10, {
      meta: makeMeta('run-v10'),
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1)] },
    });
    expect(generateReport({ runDir: onlyV10 })).toContain('no ejecutado en esta corrida');

    const withV9 = mkdtempSync(join(tmpdir(), 'bench-t8a-hdr2-'));
    writeFixtureRun(withV9, {
      meta: makeMeta('run-both'),
      a2: {
        'mind-v10': [a2('mind-v10', 'q1', 1)],
        'mind-v9': [a2('mind-v9', 'q1', 1)],
      },
    });
    expect(generateReport({ runDir: withV9 })).toContain('SHA v9 (main, ejecutado)');
  });

  test('runReport also writes the curated export', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-t8a-report-cmd-'));
    const runDir = join(repoRoot, 'runs', 'run-y');
    writeFixtureRun(runDir, {
      meta: makeMeta('run-y'),
      a2: { 'mind-v10': [a2('mind-v10', 'q1', 1)] },
    });
    const out: string[] = [];
    const code = runReport(
      { runId: 'run-y', runsRoot: 'runs', outPath: 'benchmarks/agent-memory/REPORT.md' },
      { repoRoot, stdout: line => out.push(line), stderr: () => undefined }
    );
    expect(code).toBe(0);
    expect(
      existsSync(join(repoRoot, 'benchmarks', 'agent-memory', 'results', 'run-y', 'summary.json'))
    ).toBe(true);
    expect(out.join('\n')).toContain('exported');
  });

  test('runReport returns non-zero with a clear error when the export fails', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-t8a-report-fail-'));
    const runDir = join(repoRoot, 'runs', 'run-z');
    const meta = makeMeta('run-z');
    // A secret planted in meta only: the report body does not include it, but
    // the export payload does, so the export secret scan fails closed.
    const leakyMeta = {
      ...meta,
      artifacts: { ...meta.artifacts, root: 'key sk-or-v1-abcdefghijklmnop' },
    };
    writeFixtureRun(runDir, { meta: leakyMeta, a2: { 'mind-v10': [a2('mind-v10', 'q1', 1)] } });
    const err: string[] = [];
    const code = runReport(
      { runId: 'run-z', runsRoot: 'runs', outPath: 'benchmarks/agent-memory/REPORT.md' },
      { repoRoot, stdout: () => undefined, stderr: line => err.push(line) }
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('report/export failed');
    // The public REPORT.md is not written on a failed export.
    expect(existsSync(join(repoRoot, 'benchmarks', 'agent-memory', 'REPORT.md'))).toBe(false);
  });
});
