// E-WB2 real-dump regression test (integration).
//
// Rebuilds the false-negative classification from the committed per-stage dumps
// plus the local benchmark probes/gold (under `.work/`, gitignored) and pins the
// PUBLISHED totals the report and the analysis document quote, so a refactor of
// the classifier or a dump regeneration cannot silently drift the numbers.
//
// It is skipped when the local (unversioned) probes/gold are absent — e.g. a
// clean checkout without the benchmark scratch — because the committed dumps
// alone cannot be scored without the gold evidence.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { buildClassification, type Classification } from './classify';

const here = import.meta.dir;
const agentMemory = join(here, '..', '..');
const integration = join(agentMemory, '.work/integrations/agent-memory-bench');

const paths = {
  dumps: join(agentMemory, 'experiments/REPORTS/workbench/dumps/rag-off-stages.jsonl'),
  probes: join(integration, 'results/run-mind-20261019/probes.jsonl'),
  locomo: join(integration, 'data/locomo10.json'),
  probeIndex: join(agentMemory, 'experiments/REPORTS/workbench/dumps/probe-index.json'),
  outDir: join(agentMemory, 'experiments/REPORTS/false-negatives'),
};

const available = Object.values(paths).every(path => existsSync(path));

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

if (!available) {
  test.skip('E-WB2 real-dump regression (requires gitignored experiments/REPORTS and .work artifacts)', () => {});
}

// Bun evaluates a skipped describe callback, so build the classification lazily
// inside each test: a clean checkout must skip without an ENOENT at module
// evaluation.
describe.skipIf(!available)('E-WB2 real-dump regression', () => {
  const classification = (): Classification => buildClassification(paths);

  test('published probe/item summary is stable', () => {
    const s = classification().summary as {
      probes: number;
      answerable: number;
      gold_items: number;
    };
    expect(s.probes).toBe(120);
    expect(s.answerable).toBe(92);
    expect(s.gold_items).toBe(145);
  });

  test('K=10 item labels match the published totals', () => {
    const k10 = classification().items_by_label.K10 ?? {};
    expect(k10.admitted_top10).toBe(65);
    expect(k10.admitted_outside_top10).toBe(17);
    expect(k10.dropped_by_admission).toBe(28);
    expect(k10.excluded_by_not).toBe(0);
    expect(k10.dropped_by_coverage).toBe(0);
    expect(k10.never_candidate).toBe(35);
    expect(sum(k10)).toBe(145);
  });

  test('K=25 item labels match the published totals', () => {
    const k25 = classification().items_by_label.K25 ?? {};
    expect(k25.admitted_top10).toBe(69);
    expect(k25.admitted_outside_top10).toBe(13);
    expect(k25.dropped_by_admission).toBe(28);
    expect(k25.never_candidate).toBe(35);
    expect(sum(k25)).toBe(145);
  });

  test('answerable funnel at K=10 matches the published totals', () => {
    const f10 = classification().probes_by_funnel.K10 ?? {};
    expect(f10.ALL).toBe(41);
    expect(f10.partial).toBe(10);
    expect(f10.NONE).toBe(39);
    expect(f10.no_evidence_gold).toBe(2);
  });

  test('every item carries both label_k10 and label_k25 with one label each', () => {
    for (const probe of classification().per_probe) {
      for (const item of probe.items as Array<Record<string, unknown>>) {
        expect(typeof item.label_k10).toBe('string');
        expect(typeof item.label_k25).toBe('string');
      }
    }
  });
});
