// E-WB instrumentation contract (static, copy-only).
//
// The debug instrumentation is a patch artifact: it must target exactly the
// search repository copy, be gated by `MIND_SEARCH_DEBUG`, and leave the real
// production sources free of any debug sink. This is a legitimate static
// contract for a patch asset — no production file is imported or executed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const here = import.meta.dir;
const repoRoot = join(here, '..', '..', '..', '..');
const patchPath = join(here, 'search-debug.patch');
const productionSearch = join(repoRoot, 'src/store/repositories/search-repository.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** File paths named by unified-diff headers (`--- a/x`, `+++ b/x`). */
function patchTargets(patch: string): string[] {
  const targets = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (match) targets.add(match[1]!);
  }
  return [...targets].sort();
}

describe('search-debug patch targets only the instrumented copy', () => {
  const patch = read(patchPath);

  test('names exactly src/store/repositories/search-repository.ts', () => {
    expect(patchTargets(patch)).toEqual(['src/store/repositories/search-repository.ts']);
  });

  test('the debug sink is gated by MIND_SEARCH_DEBUG', () => {
    expect(patch).toContain('MIND_SEARCH_DEBUG');
    expect(patch).toContain('process.env.MIND_SEARCH_DEBUG');
    expect(patch).toContain('activeDebugSink');
  });
});

describe('production search repository is uninstrumented', () => {
  const source = read(productionSearch);

  test('contains no debug sink, env gate or debug-only imports', () => {
    expect(source).not.toContain('MIND_SEARCH_DEBUG');
    expect(source).not.toContain('activeDebugSink');
    expect(source).not.toContain('DEBUG_RANK_CAP');
    expect(source).not.toContain('SearchDebugRecord');
    expect(source).not.toContain("from 'node:fs'");
  });
});
