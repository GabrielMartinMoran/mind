// T8a dry-run — a full 30-question × 3-rep × 2-condition simulated run with a
// fake executor: exercises reps, baseline, per-category aggregation, deltas,
// the restyled report and the curated export. No network, no cost.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { emptyA2Outcome, runA2, type A2UnitExecutor } from '../src/benchmarkA/a2';
import { BudgetGuard } from '../src/budget';
import type { ConditionId } from '../src/config';
import { isolationDirs } from '../src/isolation/opencode';
import type { SubsetItem } from '../src/locomo/subset';
import type { ConditionProfile } from '../src/opencode/conditions';
import { exportCuratedResults, generateReport } from '../src/report';

import { makeMeta } from './fixtures/bench-run';

const CATEGORY_NAMES: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

function buildFullSubset(): SubsetItem[] {
  const items: SubsetItem[] = [];
  for (const category of [1, 2, 3, 4, 5]) {
    for (let i = 0; i < 6; i++) {
      const adversarial = category === 5;
      items.push({
        id: `conv-26#${category}${i}`,
        sampleId: 'conv-26',
        questionIndex: category * 100 + i,
        category: category as SubsetItem['category'],
        categoryName: CATEGORY_NAMES[category]!,
        question: `Question ${category}-${i}?`,
        answer: adversarial ? null : `reference-${category}-${i}`,
        evidence: [`D${i}:1`],
        adversarial,
      });
    }
  }
  return items;
}

function profile(condition: ConditionId, runDir: string): ConditionProfile {
  return {
    id: condition,
    engine: condition === 'no-memory' ? null : 'v10',
    dirs: isolationDirs(join(runDir, condition)),
    env: { OPENCODE_CONFIG_CONTENT: '{}' },
    mindBin: condition === 'no-memory' ? null : '/wt/mind',
  };
}

describe('T8a dry-run', () => {
  test('30Q × 3 reps × {no-memory, mind-v10} renders aggregates, report and export', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bench-t8a-dry-'));
    const subset = buildFullSubset();
    const byId = new Map(subset.map(item => [item.id, item]));
    const conditions: ConditionId[] = ['no-memory', 'mind-v10'];
    for (const condition of conditions) mkdirSync(join(runDir, condition), { recursive: true });

    const executor: A2UnitExecutor = async job => {
      const item = byId.get(job.questionId)!;
      let answer: string;
      if (job.condition === 'mind-v10') {
        answer = item.adversarial ? 'no information available' : item.answer!;
      } else {
        // Baseline: correct only on category 1; wrong elsewhere.
        answer = item.category === 1 ? item.answer! : 'unrelated answer';
      }
      return { ...emptyA2Outcome('ok', null), answer, costUsd: 0.001, latencyMs: 3 };
    };

    const run = await runA2(
      {
        runId: 'run-t8a-dry',
        runDir,
        conditions,
        subset,
        limits: { steps: 5, timeoutMs: 5000 },
        reps: 3,
        budget: new BudgetGuard({ maxCostUsd: 5 }),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      {
        profiles: Object.fromEntries(conditions.map(c => [c, profile(c, runDir)])),
        sourceDb: { 'mind-v10': '/fake/v10.db' },
        executor,
        copyDb: () => ({ sha256: 'dry' }),
      }
    );

    // 2 conditions × 30 questions × 3 reps = 180 measurements.
    expect(run.results).toHaveLength(180);
    const v10 = run.aggregates.find(a => a.condition === 'mind-v10')!;
    expect(v10.reps).toBe(3);
    expect(v10.questionCount).toBe(30);
    expect(v10.classes.correct).toBe(72); // 24 non-adversarial Q × 3 reps
    expect(v10.classes.correct_abstention).toBe(18); // 6 adversarial Q × 3 reps
    expect(run.spentUsd).toBeCloseTo(0.18, 6);

    // Report needs meta.json alongside results.
    writeFileSync(
      join(runDir, 'meta.json'),
      `${JSON.stringify(makeMeta('run-t8a-dry'), null, 2)}\n`,
      'utf8'
    );
    const report = generateReport({ runDir });
    expect(report).toContain('A2 por categoría');
    for (const name of Object.values(CATEGORY_NAMES)) expect(report).toContain(name);
    expect(report).toContain('Delta vs baseline (no-memory)');
    expect(report).toContain('Anexo — por pregunta');
    expect(report).toContain('conv-26#10');

    const exportRoot = join(runDir, 'export');
    const curated = exportCuratedResults(runDir, 'run-t8a-dry', exportRoot);
    expect(existsSync(curated.summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(curated.summaryPath, 'utf8'));
    expect(summary.conditions['mind-v10'].a2.reps).toBe(3);
    expect(summary.diffs.a2Baseline.length).toBeGreaterThan(0);
    const perQuestion = JSON.parse(readFileSync(curated.perQuestionPath, 'utf8'));
    expect(perQuestion).toHaveLength(30);
    expect(perQuestion[0].conditions['mind-v10']).toHaveLength(3);
  });
});
