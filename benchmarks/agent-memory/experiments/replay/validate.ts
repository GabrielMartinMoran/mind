// E-WB1 validation gate.
//
// Runs the replay workbench three (four) times and asserts the gate the Lead
// requires before the raw dumps count:
//
//   a. Plain replay on the RAG-off DB: every probe's retrieved chunk count
//      equals the `context_chunks` the original run stored, and a second
//      identical run reproduces the first (determinism).
//   b. Instrumented replay: its ranked results equal the plain replay's ranked
//      results exactly — the instrumentation changes nothing — and the debug
//      sink's `admitted_ranked_final` reproduces the same order.
//
// It also produces the RAW per-stage dumps (the instrumented debug JSONL) for
// E-WB2 and writes all evidence under `experiments/REPORTS/workbench/`.
//
// Usage: bun run validate.ts [--db <db>] [--probes <jsonl>] [--worktree <plain>]
//        [--instrumented <dir>] [--reports <dir>] [--scratch <dir>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BENCHMARK_TOP_K,
  DEFAULT_SPACE,
  readProbes,
  runReplay,
  type ProbeReplayResult,
} from './replay';

interface Paths {
  db: string;
  probes: string;
  worktree: string;
  instrumented: string;
  reports: string;
  scratch: string;
}

function defaultPaths(): Paths {
  const here = import.meta.dir;
  const agentMemory = resolve(here, '..', '..');
  return {
    db: join(
      agentMemory,
      '.work/integrations/agent-memory-bench/mind-scratch/run-mind-20261019-mind-conv-26/mind.db'
    ),
    probes: join(
      agentMemory,
      '.work/integrations/agent-memory-bench/results/run-mind-20261019/probes.jsonl'
    ),
    worktree: join(agentMemory, '.work/worktrees/v10'),
    instrumented: join(agentMemory, '.work/experiments/instrumented-v10'),
    reports: join(here, '..', 'REPORTS', 'workbench'),
    scratch: join(agentMemory, '.work/experiments/replay-scratch'),
  };
}

function parsePaths(argv: readonly string[]): Paths {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i += 1;
  }
  const base = defaultPaths();
  return {
    db: flags.get('db') ?? base.db,
    probes: flags.get('probes') ?? base.probes,
    worktree: flags.get('worktree') ?? base.worktree,
    instrumented: flags.get('instrumented') ?? base.instrumented,
    reports: flags.get('reports') ?? base.reports,
    scratch: flags.get('scratch') ?? base.scratch,
  };
}

interface Mismatch {
  probe_id: string;
  expected?: number;
  actual?: number;
  detail?: string;
}

function compareCounts(probes: readonly ProbeReplayResult[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const probe of probes) {
    if (probe.expected_context_chunks === null) continue;
    if (probe.chunk_count !== probe.expected_context_chunks) {
      mismatches.push({
        probe_id: probe.probe_id,
        expected: probe.expected_context_chunks,
        actual: probe.chunk_count,
      });
    }
  }
  return mismatches;
}

function probeSignature(probe: ProbeReplayResult): string {
  return JSON.stringify({
    chunk_count: probe.chunk_count,
    http_count: probe.http_count,
    chunks: probe.chunks.map(c => ({
      name: c.name,
      content: c.content,
      score: c.score,
      confidence: c.confidence,
      methods: c.methods,
    })),
  });
}

function compareRuns(a: readonly ProbeReplayResult[], b: readonly ProbeReplayResult[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const byId = new Map(a.map(p => [p.probe_id, p]));
  for (const probe of b) {
    const other = byId.get(probe.probe_id);
    if (!other) {
      mismatches.push({ probe_id: probe.probe_id, detail: 'missing in first run' });
      continue;
    }
    if (probeSignature(other) !== probeSignature(probe)) {
      mismatches.push({ probe_id: probe.probe_id, detail: 'run signature differs' });
    }
  }
  return mismatches;
}

interface DebugRecord {
  q: string;
  admitted_ranked_final: string[];
  admitted_strict: string[];
  after_not: string[];
  zero_reason: string | null;
  admission_tier: string;
}

function readDebugRecords(path: string): DebugRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as DebugRecord);
}

/** Instrumented vs plain: HTTP ranked names equal, and the sink reproduces them. */
function compareInstrumented(
  plain: readonly ProbeReplayResult[],
  instrumented: readonly ProbeReplayResult[],
  debug: readonly DebugRecord[]
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  if (debug.length !== instrumented.length) {
    mismatches.push({
      probe_id: '(all)',
      detail: `debug records ${debug.length} != instrumented probes ${instrumented.length}`,
    });
  }
  for (let i = 0; i < instrumented.length; i += 1) {
    const instr = instrumented[i]!;
    const ref = plain.find(p => p.probe_id === instr.probe_id);
    if (!ref) {
      mismatches.push({ probe_id: instr.probe_id, detail: 'missing in plain replay' });
      continue;
    }
    const instrNames = instr.chunks.map(c => c.name);
    const refNames = ref.chunks.map(c => c.name);
    if (JSON.stringify(instrNames) !== JSON.stringify(refNames)) {
      mismatches.push({ probe_id: instr.probe_id, detail: 'HTTP ranked names differ from plain' });
      continue;
    }
    const record = debug[i];
    if (record && record.q !== instr.question) {
      mismatches.push({ probe_id: instr.probe_id, detail: 'debug/ probe order mismatch' });
      continue;
    }
    const finalNames = record ? record.admitted_ranked_final : [];
    if (JSON.stringify(finalNames.slice(0, refNames.length)) !== JSON.stringify(refNames)) {
      mismatches.push({
        probe_id: instr.probe_id,
        detail: 'admitted_ranked_final prefix differs from plain ranked names',
      });
    }
  }
  return mismatches;
}

async function main(): Promise<void> {
  const paths = parsePaths(process.argv.slice(2));
  const probes = readProbes(paths.probes);
  mkdirSync(paths.reports, { recursive: true });
  const dumpsDir = join(paths.reports, 'dumps');
  mkdirSync(dumpsDir, { recursive: true });

  const plain1 = await runReplay({
    worktree: paths.worktree,
    db: paths.db,
    probes: paths.probes,
    out: join(paths.scratch, 'plain-run-1.json'),
    scratchDir: join(paths.scratch, 'plain-1'),
    limit: BENCHMARK_TOP_K,
  });
  const plain2 = await runReplay({
    worktree: paths.worktree,
    db: paths.db,
    probes: paths.probes,
    out: join(paths.scratch, 'plain-run-2.json'),
    scratchDir: join(paths.scratch, 'plain-2'),
    limit: BENCHMARK_TOP_K,
  });

  const instrSink = join(paths.scratch, 'instrumented-10-stages.jsonl');
  if (existsSync(instrSink)) writeFileSync(instrSink, '');
  const instrumented10 = await runReplay({
    worktree: paths.instrumented,
    db: paths.db,
    probes: paths.probes,
    out: join(paths.scratch, 'instrumented-run-10.json'),
    scratchDir: join(paths.scratch, 'instrumented-10'),
    limit: BENCHMARK_TOP_K,
    debugSink: instrSink,
  });

  // E-WB2 input: the same instrumented stages at limit=25 (task-specified depth).
  const dumpsSink = join(dumpsDir, 'rag-off-stages.jsonl');
  if (existsSync(dumpsSink)) writeFileSync(dumpsSink, '');
  const instrumented25 = await runReplay({
    worktree: paths.instrumented,
    db: paths.db,
    probes: paths.probes,
    out: join(paths.scratch, 'instrumented-run-25.json'),
    scratchDir: join(paths.scratch, 'instrumented-25'),
    limit: 25,
    debugSink: dumpsSink,
  });

  const debug10 = readDebugRecords(instrSink);
  const countsMismatches = compareCounts(plain1.probes);
  const determinismMismatches = compareRuns(plain1.probes, plain2.probes);
  const instrumentedMismatches = compareInstrumented(plain1.probes, instrumented10.probes, debug10);

  const evidence = {
    feature: '00009-memory-recall-investigation',
    task: 'E-WB2 re-validation after dump upgrade',
    generated_at: new Date().toISOString(),
    config: {
      db_source: resolve(paths.db),
      probes: resolve(paths.probes),
      space: DEFAULT_SPACE,
      probe_count: probes.length,
      validation_limit: BENCHMARK_TOP_K,
      dump_limit: 25,
      dump_rank_cap: 1000,
      worktree_plain: resolve(paths.worktree),
      worktree_instrumented: resolve(paths.instrumented),
    },
    counts_match: {
      passed: countsMismatches.length === 0,
      matched: probes.length - countsMismatches.length,
      total: probes.length,
      mismatches: countsMismatches,
    },
    determinism: {
      passed: determinismMismatches.length === 0,
      compared: probes.length,
      mismatches: determinismMismatches,
    },
    instrumented_equals_plain: {
      passed: instrumentedMismatches.length === 0,
      compared: instrumented10.probes.length,
      mismatches: instrumentedMismatches,
    },
    artifacts: {
      plain_run_1: resolve(join(paths.scratch, 'plain-run-1.json')),
      plain_run_2: resolve(join(paths.scratch, 'plain-run-2.json')),
      instrumented_run_10: resolve(join(paths.scratch, 'instrumented-run-10.json')),
      instrumented_run_25: resolve(join(paths.scratch, 'instrumented-run-25.json')),
      stages_validation_jsonl: resolve(instrSink),
      dumps_jsonl: resolve(dumpsSink),
    },
  };

  writeFileSync(
    join(paths.reports, 'validation-rag-off.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  );

  // Probe index for correlating dump order with probe ids (E-WB2 input).
  const debug25 = readDebugRecords(dumpsSink);
  const index = instrumented25.probes.map((probe, seq) => {
    const record = debug25[seq];
    return {
      seq,
      probe_id: probe.probe_id,
      category: probe.category,
      adversarial: probe.adversarial,
      expected_context_chunks: probe.expected_context_chunks,
      chunk_count: probe.chunk_count,
      zero_reason: record?.zero_reason ?? null,
      admission_tier: record?.admission_tier ?? null,
    };
  });
  writeFileSync(join(dumpsDir, 'probe-index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const allPassed =
    evidence.counts_match.passed &&
    evidence.determinism.passed &&
    evidence.instrumented_equals_plain.passed;
  process.stdout.write(
    JSON.stringify(
      {
        counts: `${evidence.counts_match.matched}/${evidence.counts_match.total}`,
        determinism: evidence.determinism.passed,
        instrumented_equals_plain: evidence.instrumented_equals_plain.passed,
        passed: allPassed,
      },
      null,
      2
    ) + '\n'
  );
  if (!allPassed) process.exitCode = 1;
}

if (import.meta.main) await main();
