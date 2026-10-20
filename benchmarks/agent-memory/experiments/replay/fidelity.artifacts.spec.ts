// E-WB1 replay-fidelity regression test (integration).
//
// Pins the PUBLISHED validation gate of the replay workbench: the plain replay
// reproduces the stored `context_chunks` counts for all 120 probes, two
// consecutive plain replays are identical, and the instrumented replay equals
// the plain replay. The committed `validation-rag-off.json` is the evidence the
// workbench report (and the analysis document) quote.
//
// The gate is data-gated on the local (unversioned) benchmark scratch under
// `.work/`: without the frozen DB, probes and worktrees the replay cannot be
// re-run or re-validated, so the test skips cleanly instead of mocking it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const here = import.meta.dir;
const agentMemory = join(here, '..', '..');
const integration = join(agentMemory, '.work/integrations/agent-memory-bench');
const scratch = join(agentMemory, '.work/experiments/replay-scratch');

const workArtifacts = [
  join(integration, 'mind-scratch/run-mind-20261019-mind-conv-26/mind.db'),
  join(integration, 'results/run-mind-20261019/probes.jsonl'),
  join(agentMemory, '.work/worktrees/v10'),
  join(agentMemory, '.work/experiments/instrumented-v10'),
  join(scratch, 'plain-run-1.json'),
  join(scratch, 'plain-run-2.json'),
  join(scratch, 'instrumented-run-10.json'),
  join(scratch, 'instrumented-10-stages.jsonl'),
];

const validationPath = join(here, '..', 'REPORTS', 'workbench', 'validation-rag-off.json');
const available = existsSync(validationPath) && workArtifacts.every(path => existsSync(path));

interface ValidationEvidence {
  config: { probe_count: number };
  counts_match: { passed: boolean; matched: number; total: number; mismatches: unknown[] };
  determinism: { passed: boolean; compared: number; mismatches: unknown[] };
  instrumented_equals_plain: { passed: boolean; compared: number; mismatches: unknown[] };
}

describe.skipIf(!available)('replay fidelity against the stored benchmark run', () => {
  const evidence = JSON.parse(readFileSync(validationPath, 'utf8')) as ValidationEvidence;

  test('every probe reproduces its stored chunk count', () => {
    expect(evidence.config.probe_count).toBe(120);
    expect(evidence.counts_match.passed).toBe(true);
    expect(evidence.counts_match.matched).toBe(120);
    expect(evidence.counts_match.total).toBe(120);
    expect(evidence.counts_match.mismatches).toEqual([]);
  });

  test('two consecutive plain replays are identical', () => {
    expect(evidence.determinism.passed).toBe(true);
    expect(evidence.determinism.compared).toBe(120);
    expect(evidence.determinism.mismatches).toEqual([]);
  });

  test('instrumented replay equals the plain replay', () => {
    expect(evidence.instrumented_equals_plain.passed).toBe(true);
    expect(evidence.instrumented_equals_plain.compared).toBe(120);
    expect(evidence.instrumented_equals_plain.mismatches).toEqual([]);
  });
});
