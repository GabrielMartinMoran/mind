// Free LoCoMo A1 command: worktrees -> fetch -> subset -> per-condition
// (deterministic ingest -> A1 retrieval). No LLM calls, no cost.
//
// Stage statuses are recorded in the run metadata (`meta.json`), reusing the
// T2 run helpers. Derived artifacts (`subset.json`, per-condition results) live
// in the gitignored run directory; the real dataset is never copied into the
// repository.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DATASET,
  DEFAULT_LIMITS,
  MODEL,
  engineForCondition,
  type ConditionId,
  type EngineVersion,
} from '../config';
import { createMindCurrentEngine, type MindEngineAdapter } from '../engines/mind-engine';
import { createMindV10Engine } from '../engines/mind-v10';
import { createMindV9Engine } from '../engines/mind-v9';
import type { CommandRunner } from '../exec';
import { inspectEmbeddingCoverage, type InspectedEmbeddingCoverage } from '../mind/inspect';
import { ensureWorktree, readSchemaInfo } from '../mind/worktree';
import { loadCredentialEnv } from '../opencode/credentials';
import {
  createRunId,
  createRunLayout,
  createRunMeta,
  ragMeta,
  readCheckoutProvenance,
  writeRunMeta,
  withStage,
  type CheckoutProvenance,
  type RunMeta,
} from '../run';
import { captureToolVersions } from '../versions';

import { runA1, type A1Result } from './a1';
import { DATASET_ATTRIBUTION, fetchDataset, type FetchedDataset } from './fetch';
import { conversationTurns, ingestConversation } from './ingest';
import { DEFAULT_CONVERSATION, DEFAULT_SEED, buildSubsetArtifact, type SubsetName } from './subset';
import type { LocomoDataset } from './types';

export interface LocomoCommandOptions {
  readonly subset: SubsetName;
  readonly conditions: readonly ConditionId[];
  readonly runId: string | null;
  readonly runsRoot: string;
  readonly workRoot: string;
  /** Run-level embeddings switch for ingest and A1 query-time search. */
  readonly rag?: boolean;
}

export interface EmbeddingCoverageCheck {
  readonly ok: boolean;
  readonly expected: number;
  readonly embedded: number;
  readonly missing: readonly string[];
  readonly detail: string;
}

/**
 * Assert that every expected memory in `space` carries an embedding. Reads only
 * presence (never vectors) and fails closed on any missing expected name.
 */
export function checkEmbeddingCoverage(
  dbPath: string,
  space: string,
  expectedNames: readonly string[]
): EmbeddingCoverageCheck {
  const coverage = inspectEmbeddingCoverage(dbPath, space, expectedNames);
  return evaluateEmbeddingCoverage(coverage, expectedNames);
}

export function evaluateEmbeddingCoverage(
  coverage: readonly InspectedEmbeddingCoverage[],
  expectedNames: readonly string[]
): EmbeddingCoverageCheck {
  const embeddedNames = new Set(coverage.filter(row => row.hasEmbedding).map(row => row.name));
  const missing = expectedNames.filter(name => !embeddedNames.has(name));
  const embedded = expectedNames.length - missing.length;
  const ok = expectedNames.length > 0 && missing.length === 0;
  const detail = ok
    ? `${embedded}/${expectedNames.length} memories embedded`
    : `${embedded}/${expectedNames.length} memories embedded (missing ${missing.length})`;
  return { ok, expected: expectedNames.length, embedded, missing, detail };
}

export interface LocomoCommandDeps {
  readonly repoRoot: string;
  readonly runner: CommandRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Injectable for tests; defaults to the real dataset fetcher. */
  readonly fetchDatasetFn?: typeof fetchDataset;
  /** Injectable for tests; defaults to reading the real checkout. */
  readonly provenanceFn?: (repoRoot: string, dbPath: string | null) => CheckoutProvenance;
  /**
   * Explicit embedding credential env for a RAG run. An explicit value
   * (including `{}`) wins, so tests never touch the auth store.
   */
  readonly credentialEnv?: Record<string, string>;
  /** Overrides the auth store path (tests). */
  readonly authPath?: string;
}

/**
 * Resolve the embedding credential exactly like A2/B: an explicit value wins,
 * otherwise the authorized provider key is read from `auth.json` at runtime.
 */
function resolveEmbeddingCredentialEnv(
  options: LocomoCommandOptions,
  deps: LocomoCommandDeps
): Record<string, string> {
  if (options.rag !== true) return {};
  if (deps.credentialEnv) return deps.credentialEnv;
  return loadCredentialEnv(MODEL, { authPath: deps.authPath });
}

function currentSchemaVersion(dbPath: string): number | null {
  try {
    return readSchemaInfo(dbPath).schemaVersion;
  } catch {
    return null;
  }
}

function createEngine(
  version: EngineVersion,
  deps: LocomoCommandDeps,
  bin: string,
  conditionDir: string,
  space: string,
  rag: boolean,
  credentialEnv: Record<string, string>
): MindEngineAdapter {
  const baseEnv =
    rag && Object.keys(credentialEnv).length > 0 ? { ...process.env, ...credentialEnv } : undefined;
  const shared = {
    bin,
    paths: {
      dataDir: conditionDir,
      dbPath: join(conditionDir, 'mind.db'),
      syncRoot: join(conditionDir, 'syncroot'),
    },
    space,
    cwd: conditionDir,
    rag,
    ...(baseEnv ? { baseEnv } : {}),
    runner: deps.runner,
  };
  if (version === 'v9') return createMindV9Engine(shared);
  if (version === 'current') return createMindCurrentEngine(shared);
  return createMindV10Engine(shared);
}

function summarizeA1(a1: A1Result): Record<string, unknown> {
  const mean = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));
  return {
    cat1To4: {
      count: a1.aggregates.overallCat1To4.count,
      hitAt5: mean(a1.aggregates.overallCat1To4.hitAt5),
      hitAt10: mean(a1.aggregates.overallCat1To4.hitAt10),
      evidenceRecallAt10: mean(a1.aggregates.overallCat1To4.evidenceRecallAt10),
      mrr: mean(a1.aggregates.overallCat1To4.mrr),
      precisionAt10: mean(a1.aggregates.overallCat1To4.precisionAt10),
      latencyP50Ms: a1.aggregates.overallCat1To4.latencyP50Ms,
    },
    cat5Adversarial: {
      count: a1.aggregates.cat5Adversarial.count,
      evidenceRecallAt10: mean(a1.aggregates.cat5Adversarial.evidenceRecallAt10),
      mrr: mean(a1.aggregates.cat5Adversarial.mrr),
    },
  };
}

export async function runLocomoCommand(
  options: LocomoCommandOptions,
  deps: LocomoCommandDeps
): Promise<number> {
  const mindConditions = options.conditions.filter(
    condition => engineForCondition(condition) !== null
  );
  if (mindConditions.length === 0) {
    deps.stderr(
      'locomo A1 requires at least one Mind condition (mind-current by default; ' +
        'mind-v9 or mind-v10 for historical comparisons).'
    );
    return 2;
  }

  const runId = options.runId ?? createRunId();
  // Roots may arrive repo-relative (CLI defaults); resolve so the pinned `mind`
  // binary and the run dirs are spawned from absolute paths regardless of cwd.
  const runsRoot = resolve(deps.repoRoot, options.runsRoot);
  const workRoot = resolve(deps.repoRoot, options.workRoot);
  const layout = createRunLayout({ runRoot: runsRoot, workRoot }, runId, mindConditions);
  // Record the exact OpenCode/SDK/Bun versions up front (free). Best-effort:
  // a missing binary/package yields `null` rather than failing the run.
  const versions = await captureToolVersions(deps.runner, { repoRoot: deps.repoRoot }).catch(
    () => ({ opencode: null, sdk: null, bun: Bun.version })
  );
  const current =
    mindConditions.includes('mind-current') && layout.conditions['mind-current']
      ? (deps.provenanceFn ?? ((root, dbPath) => readCheckoutProvenance(root, { dbPath })))(
          deps.repoRoot,
          join(layout.conditions['mind-current'].dir, 'mind.db')
        )
      : undefined;
  let meta: RunMeta = createRunMeta({
    layout,
    shas: { v9: null, v10: null },
    versions,
    model: MODEL,
    dataset: { url: DATASET.url, sha256: null },
    subset: { seed: DEFAULT_SEED, count: 0, conversation: DEFAULT_CONVERSATION },
    limits: DEFAULT_LIMITS,
    budget: { maxCostUsd: 0, spentUsd: 0 },
    rag: ragMeta(options.rag === true),
    activeConditions: mindConditions,
    ...(current ? { current } : {}),
  });
  const save = (next: RunMeta): void => {
    meta = next;
    writeRunMeta(layout.metaPath, meta);
  };
  save(withStage(meta, 'locomo:start', 'running'));
  deps.stdout(
    `locomo run ${runId}: subset=${options.subset} conditions=${mindConditions.join(',')}` +
      (options.rag === true ? ' rag=openrouter' : '')
  );

  // A RAG ingest needs the embedding credential before any paid/embedded work.
  let embeddingCredentialEnv: Record<string, string> = {};
  try {
    embeddingCredentialEnv = resolveEmbeddingCredentialEnv(options, deps);
  } catch (error) {
    save(withStage(meta, 'embeddings:credentials', 'failed', String(error)));
    deps.stderr(`embedding credential unavailable: ${String(error)}`);
    return 1;
  }
  if (options.rag === true) save(withStage(meta, 'embeddings:credentials', 'passed'));

  // Stage: ensure-worktrees
  save(withStage(meta, 'ensure-worktrees', 'running'));
  const worktrees: Partial<Record<EngineVersion, string>> = {};
  try {
    for (const condition of mindConditions) {
      const version = engineForCondition(condition);
      if (version === null) continue;
      if (version === 'current') {
        const mindBin = join(deps.repoRoot, 'mind');
        if (!existsSync(mindBin)) {
          throw new Error(`mind-current requires the local checkout at '${mindBin}'`);
        }
        worktrees.current = deps.repoRoot;
        continue;
      }
      const info = await ensureWorktree({
        repoRoot: deps.repoRoot,
        workRoot,
        version,
        runner: deps.runner,
      });
      worktrees[version] = info.path;
      save({ ...meta, shas: { ...meta.shas, [version]: info.sha } });
    }
  } catch (error) {
    save(withStage(meta, 'ensure-worktrees', 'failed', String(error)));
    deps.stderr(`ensure-worktrees failed: ${String(error)}`);
    return 1;
  }
  save(withStage(meta, 'ensure-worktrees', 'passed'));

  // Stage: fetch
  save(withStage(meta, 'fetch', 'running'));
  let fetched: FetchedDataset;
  let dataset: LocomoDataset;
  try {
    const fetchFn = deps.fetchDatasetFn ?? fetchDataset;
    fetched = await fetchFn({
      cacheDir: join(workRoot, 'dataset'),
      expectedSha256: DATASET.expectedSha256,
    });
    dataset = JSON.parse(readFileSync(fetched.path, 'utf8')) as LocomoDataset;
  } catch (error) {
    save(withStage(meta, 'fetch', 'failed', String(error)));
    deps.stderr(`dataset fetch failed: ${String(error)}`);
    return 1;
  }
  save({
    ...meta,
    dataset: { url: fetched.url, sha256: fetched.sha256 },
    artifacts: { ...meta.artifacts, root: layout.runDir },
  });
  save(withStage(meta, 'fetch', 'passed', `sha256=${fetched.sha256}`));
  deps.stdout(
    `dataset sha256=${fetched.sha256} bytes=${fetched.bytes} fromCache=${fetched.fromCache}`
  );
  deps.stdout(DATASET_ATTRIBUTION);

  // Stage: subset
  save(withStage(meta, 'subset', 'running'));
  const subset = buildSubsetArtifact(dataset, {
    subset: options.subset,
    seed: DEFAULT_SEED,
    conversation: DEFAULT_CONVERSATION,
    datasetSha256: fetched.sha256,
  });
  writeFileSync(join(layout.runDir, 'subset.json'), `${JSON.stringify(subset, null, 2)}\n`, 'utf8');
  save({
    ...meta,
    subset: {
      seed: subset.seed,
      count: subset.items.length,
      conversation: subset.conversation,
    },
  });
  save(withStage(meta, 'subset', 'passed', `${subset.items.length} questions`));
  deps.stdout(`subset ${options.subset}: ${subset.items.length} questions`);

  const space = `locomo/${DEFAULT_CONVERSATION}`;
  const summary: Record<string, unknown> = {};

  for (const condition of mindConditions) {
    const version = engineForCondition(condition);
    const bin = version === null ? undefined : worktrees[version];
    if (version === null || bin === undefined) continue;
    const conditionDir = layout.conditions[condition].dir;
    const engine = createEngine(
      version,
      deps,
      join(bin, 'mind'),
      conditionDir,
      space,
      options.rag === true,
      embeddingCredentialEnv
    );

    try {
      save(withStage(meta, `${condition}:ingest`, 'running'));
      const ingest = await ingestConversation(engine, dataset, {
        conversation: DEFAULT_CONVERSATION,
      });
      writeFileSync(
        join(layout.resultsDir, `${condition}-ingest.json`),
        `${JSON.stringify(ingest, null, 2)}\n`,
        'utf8'
      );
      save(
        withStage(
          meta,
          `${condition}:ingest`,
          'passed',
          `${ingest.turns} turns in ${Math.round(ingest.ingestMs)}ms`
        )
      );
      deps.stdout(
        `${condition}: ingest ${ingest.turns} turns in ${Math.round(ingest.ingestMs)}ms ` +
          `(${ingest.msPerTurn.toFixed(1)} ms/turn); verified=${ingest.verification.ok}`
      );

      // Fail closed before A1 scoring (and any later A2) when embeddings are
      // incomplete: a RAG run with partial coverage is not a valid measurement.
      if (options.rag === true) {
        const expectedNames = conversationTurns(dataset, DEFAULT_CONVERSATION).map(
          turn => turn.diaId
        );
        const coverage = checkEmbeddingCoverage(
          join(conditionDir, 'mind.db'),
          space,
          expectedNames
        );
        if (!coverage.ok) {
          const message =
            `embeddings incomplete after ingest for '${condition}': ${coverage.detail}; ` +
            `aborting before A1 scoring`;
          save(withStage(meta, `${condition}:embeddings`, 'failed', message));
          deps.stderr(message);
          return 1;
        }
        save(withStage(meta, `${condition}:embeddings`, 'passed', coverage.detail));
        deps.stdout(`${condition}: embeddings ${coverage.detail}`);
      }

      // The current database only exists after ingest; record its real schema
      // now so a current run carries the complete provenance block.
      if (version === 'current' && meta.current && meta.current.schemaVersion === null) {
        save({
          ...meta,
          current: {
            ...meta.current,
            schemaVersion: currentSchemaVersion(join(conditionDir, 'mind.db')),
          },
        });
      }

      save(withStage(meta, `${condition}:a1`, 'running'));
      const a1 = await runA1(engine, subset.items, { space });
      writeFileSync(
        join(layout.resultsDir, `${condition}-a1.json`),
        `${JSON.stringify(a1, null, 2)}\n`,
        'utf8'
      );
      save(withStage(meta, `${condition}:a1`, 'passed'));
      summary[condition] = summarizeA1(a1);
      const cat14 = a1.aggregates.overallCat1To4;
      deps.stdout(
        `${condition}: A1 cat1-4 hit@5=${cat14.hitAt5?.toFixed(3) ?? 'n/a'} ` +
          `hit@10=${cat14.hitAt10?.toFixed(3) ?? 'n/a'} ` +
          `recall@10=${cat14.evidenceRecallAt10?.toFixed(3) ?? 'n/a'} ` +
          `mrr=${cat14.mrr?.toFixed(3) ?? 'n/a'} p50=${cat14.latencyP50Ms?.toFixed(1) ?? 'n/a'}ms`
      );
    } catch (error) {
      save(withStage(meta, `${condition}:a1`, 'failed', String(error)));
      deps.stderr(`${condition}: failed: ${String(error)}`);
      await engine.cleanup(space).catch(() => undefined);
      return 1;
    } finally {
      await engine.cleanup(space).catch(() => undefined);
    }
  }

  save(withStage(meta, 'locomo:start', 'passed', `${mindConditions.length} condition(s)`));
  save(withStage(meta, 'locomo:done', 'passed'));
  writeFileSync(
    join(layout.resultsDir, 'locomo-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8'
  );
  deps.stdout(`locomo run complete: ${layout.runDir}`);
  return 0;
}
