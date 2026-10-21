import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CONDITIONS, DEFAULT_LIMITS, MODEL } from '../src/config';
import {
  createRunId,
  createRunLayout,
  createRunMeta,
  readRunMeta,
  withStage,
  writeRunMeta,
  type RunMeta,
} from '../src/run';

describe('run id', () => {
  test('has the run-YYYYMMDD-HHMMSS-<4hex> shape', () => {
    const id = createRunId(new Date('2026-10-18T09:30:15Z'), () => 'ab12');
    expect(id).toBe('run-20261018-093015-ab12');
  });

  test('uses the injected randomness for uniqueness', () => {
    const a = createRunId(new Date(0), () => 'aaaa');
    const b = createRunId(new Date(0), () => 'bbbb');
    expect(a).not.toBe(b);
  });
});

describe('run layout', () => {
  test('creates a results dir and one opencode/workspace dir per condition', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-layout-'));
    const layout = createRunLayout({ runRoot: root, workRoot: root }, 'run-test', CONDITIONS);

    expect(layout.resultsDir.startsWith(layout.runDir)).toBe(true);
    for (const condition of CONDITIONS) {
      expect(layout.conditions[condition].opencodeDir.startsWith(layout.runDir)).toBe(true);
      expect(layout.conditions[condition].workspaceDir.startsWith(layout.runDir)).toBe(true);
    }
  });
});

describe('run meta (contract)', () => {
  test('records everything needed to reproduce the run', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-meta-'));
    const layout = createRunLayout({ runRoot: root, workRoot: root }, 'run-meta', CONDITIONS);

    const meta: RunMeta = createRunMeta({
      layout,
      shas: { v9: '36d2f1e'.padEnd(40, '0'), v10: 'c7029b3'.padEnd(40, '0') },
      versions: { opencode: '2.0.28', sdk: '2.0.28', bun: '1.3.14' },
      model: MODEL,
      dataset: { url: 'https://example.test/locomo10.json', sha256: 'deadbeef' },
      subset: { seed: 20261018, count: 5, conversation: 'conv-26' },
      limits: DEFAULT_LIMITS,
      budget: { maxCostUsd: 5, spentUsd: 0 },
    });

    expect(meta.runId).toBe('run-meta');
    expect(meta.shas.v9).toContain('36d2f1e');
    expect(meta.shas.v10).toContain('c7029b3');
    expect(meta.versions).toEqual({ opencode: '2.0.28', sdk: '2.0.28', bun: '1.3.14' });
    expect(meta.model).toEqual(MODEL);
    expect(meta.dataset.sha256).toBe('deadbeef');
    expect(meta.subset.seed).toBe(20261018);
    expect(meta.limits).toEqual(DEFAULT_LIMITS);
    expect(meta.budget.maxCostUsd).toBe(5);
    expect(meta.artifacts.conditions['mind-v10']).toBe(layout.conditions['mind-v10'].dir);

    const staged = withStage(withStage(meta, 'isolation', 'passed'), 'a1', 'pending');
    writeRunMeta(layout.metaPath, staged);
    const read = readRunMeta(layout.metaPath);

    expect(read.stages.isolation!.status).toBe('passed');
    expect(read.stages.a1!.status).toBe('pending');
    expect(read.runId).toBe(meta.runId);
    expect(read.model.providerID).toBe('openrouter');
  });
});
