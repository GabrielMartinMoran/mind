// Provenance metadata contract: a current checkout run must record enough to
// reproduce it, and the artifact map must stay partial because only selected
// conditions exist in a run directory.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { DEFAULT_LIMITS, MODEL } from '../src/config';
import {
  createRunLayout,
  createRunMeta,
  mergeActiveConditions,
  readCheckoutProvenance,
  type ProvenanceDeps,
} from '../src/run';

function metaInput(root: string, conditions: ('mind-current' | 'mind-v9')[]) {
  const layout = createRunLayout({ runRoot: root, workRoot: root }, 'run-prov', conditions);
  return {
    layout,
    shas: { v9: null, v10: null },
    versions: { opencode: null, sdk: null, bun: '1.3.14' },
    model: MODEL,
    dataset: { url: 'https://example.test/locomo.json', sha256: null },
    subset: { seed: 1, count: 0, conversation: 'conv-26' },
    limits: DEFAULT_LIMITS,
    budget: { maxCostUsd: 0, spentUsd: 0 },
  };
}

function fakeGit(branch: string, sha: string, status: string): ProvenanceDeps['git'] {
  return args => {
    if (args.includes('--abbrev-ref')) return { stdout: `${branch}\n`, exitCode: 0 };
    if (args.includes('rev-parse')) return { stdout: `${sha}\n`, exitCode: 0 };
    if (args.includes('--porcelain')) return { stdout: status, exitCode: 0 };
    return { stdout: '', exitCode: 1 };
  };
}

describe('readCheckoutProvenance', () => {
  test('records branch, HEAD, dirty state, package version, schema and binary', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-prov-'));
    mkdirSync(join(repoRoot, 'mind'));
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ version: '1.6.0' }), 'utf8');
    writeFileSync(join(repoRoot, 'mind.db'), '', 'utf8');

    const deps: ProvenanceDeps = {
      git: fakeGit('feat/current', 'abc123def', ' M src/run.ts\n'),
      readSchema: () => ({ schemaVersion: 10 }),
      readTextFile: path => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
    };

    expect(readCheckoutProvenance(repoRoot, { dbPath: join(repoRoot, 'mind.db') }, deps)).toEqual({
      branch: 'feat/current',
      headSha: 'abc123def',
      dirty: true,
      packageVersion: '1.6.0',
      schemaVersion: 10,
      mindBinary: join(repoRoot, 'mind'),
    });
  });

  test('missing schema, package version and binary yield explicit nulls without crashing', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'bench-prov-missing-'));

    const provenance = readCheckoutProvenance(
      repoRoot,
      { dbPath: join(repoRoot, 'missing.db') },
      {
        git: fakeGit('', '', ''),
        readSchema: () => null,
        readTextFile: () => null,
      }
    );

    expect(provenance.branch).toBeNull();
    expect(provenance.headSha).toBeNull();
    expect(provenance.dirty).toBe(false);
    expect(provenance.packageVersion).toBeNull();
    expect(provenance.schemaVersion).toBeNull();
    expect(provenance.mindBinary).toBeNull();
  });
});

describe('run metadata active conditions and artifacts', () => {
  test('a partial condition set records only the conditions that exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-prov-meta-'));
    const input = metaInput(root, ['mind-current']);

    const meta = createRunMeta(input);

    expect(meta.activeConditions).toEqual(['mind-current']);
    expect(Object.keys(meta.artifacts.conditions)).toEqual(['mind-current']);
    expect(meta.artifacts.conditions['mind-current']).toBe(
      input.layout.conditions['mind-current'].dir
    );
    expect(meta.artifacts.conditions['mind-v9']).toBeUndefined();
  });

  test('mergeActiveConditions unions stages deterministically', () => {
    expect(mergeActiveConditions(['mind-current'], ['no-memory', 'mind-current'])).toEqual([
      'no-memory',
      'mind-current',
    ]);
    expect(mergeActiveConditions(undefined, ['mind-v9', 'mind-current'])).toEqual([
      'mind-v9',
      'mind-current',
    ]);
  });
});
