// Guard: the agent-memory benchmark is an independent Bun subproject.
//
// The root install must not carry benchmark-only dependencies, the root
// TypeScript program must not include the harness, and the subproject must own
// its manifest, lockfile, and tsconfig.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..');
const benchRoot = join(repoRoot, 'benchmarks/agent-memory');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function section(pkg: Record<string, unknown>, key: string): Record<string, string> {
  const value = pkg[key];
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

/** Whether git would ignore a repository-relative path (index-independent). */
function isIgnored(relativePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', relativePath], {
    cwd: repoRoot,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed (${result.status}): ${result.stderr?.toString() ?? ''}`);
}

/** Recipe lines for a Make target as written in the root Makefile. */
function makeRecipe(target: string): string {
  const lines = readFileSync(join(repoRoot, 'Makefile'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.startsWith(`${target}:`));
  if (start === -1) return '';
  const recipe: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break;
    recipe.push(line);
  }
  return recipe.join('\n');
}

describe('benchmark isolation', () => {
  test('the root package does not depend on benchmark-only packages', () => {
    const pkg = readJson(join(repoRoot, 'package.json'));
    const deps = section(pkg, 'dependencies');
    const devDeps = section(pkg, 'devDependencies');

    expect(deps['@opencode/sdk']).toBeUndefined();
    expect(devDeps['@opencode/sdk']).toBeUndefined();
    expect(deps['bun-style']).toBeUndefined();
    expect(devDeps['bun-style']).toBeUndefined();
    expect(pkg.workspaces).toBeUndefined();
  });

  test('the root lockfile has no @opencode entries', () => {
    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
    expect(lock).not.toContain('"@opencode');
    expect(lock).not.toContain('bun-style');
  });

  test('the root tsconfig does not include the benchmark', () => {
    const tsconfig = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8');
    expect(tsconfig).not.toContain('benchmarks/agent-memory');
  });

  test('the subproject owns its manifest, lockfile, and tsconfig', () => {
    for (const name of ['package.json', 'bun.lock', 'tsconfig.json']) {
      expect(existsSync(join(benchRoot, name))).toBe(true);
    }

    const pkg = readJson(join(benchRoot, 'package.json'));
    expect(pkg.name).toBe('mind-agent-memory-benchmark');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(section(pkg, 'dependencies')['@opencode/sdk']).toBe('2.0.28');
    expect(pkg.workspaces).toBeUndefined();

    const scripts = section(pkg, 'scripts');
    for (const script of [
      'cli',
      'test',
      'test:experiments',
      'test:integration',
      'typecheck',
      'probe',
      'smoke',
      'locomo',
      'scenarios',
      'full',
      'report',
      'clean',
    ]) {
      expect(typeof scripts[script]).toBe('string');
    }
    expect(scripts.prepare).toBeUndefined();
    expect(scripts.postinstall).toBeUndefined();
  });

  test('the subproject lockfile resolves its own SDK version', () => {
    const lock = readFileSync(join(benchRoot, 'bun.lock'), 'utf8');
    expect(lock).toContain('@opencode/sdk');
    expect(lock).toContain('2.0.28');
  });

  test('the subproject tsconfig is standalone and excludes the scratch probe', () => {
    const tsconfig = readFileSync(join(benchRoot, 'tsconfig.json'), 'utf8');
    expect(tsconfig).not.toContain('"extends"');
    expect(tsconfig).toContain('probes/sdk-probe');
  });

  test('the duplicated scratch SDK probe package is gone', () => {
    expect(existsSync(join(benchRoot, 'probes/sdk-probe/package.json'))).toBe(false);
    expect(existsSync(join(benchRoot, 'probes/sdk-probe/bun.lock'))).toBe(false);
  });

  test('versionable benchmark manifests and sources are not gitignored', () => {
    const versionable = [
      'package.json',
      'bun.lock',
      'tsconfig.json',
      'src/cli.ts',
      'test/cli.spec.ts',
      'fixtures/b1/package.json',
      'experiments/topk/topk.ts',
      'probes/run-t1-probes.sh',
      'probes/smoke-openrouter.ts',
      'README.md',
      'ANALYSIS.md',
    ];

    for (const path of versionable) {
      expect(isIgnored(`benchmarks/agent-memory/${path}`), path).toBe(false);
    }
  });

  test('generated benchmark artifacts stay gitignored', () => {
    const generated = [
      'runs',
      'results',
      'REPORT.md',
      '.work',
      // Probe a file inside the ignored directory: `git check-ignore` cannot
      // match the bare directory when it does not exist in a clean checkout,
      // but it still matches a path under the trailing-slash pattern.
      'experiments/REPORTS/validation-rag-off.json',
      'probes/evidence/probe.json',
    ];

    for (const path of generated) {
      expect(isIgnored(`benchmarks/agent-memory/${path}`), path).toBe(true);
    }
  });

  test('makefile benchmark targets run inside the subproject', () => {
    const targets = [
      'test',
      'probe',
      'smoke',
      'locomo',
      'scenarios',
      'answers',
      'full',
      'report',
      'clean',
    ];

    for (const target of targets) {
      const recipe = makeRecipe(`bench-agent-memory-${target}`);
      expect(recipe, target).toContain('cd benchmarks/agent-memory');
    }
  });

  test('paid make targets still forward BUDGET and CONFIRM', () => {
    for (const target of ['scenarios', 'answers', 'full']) {
      const recipe = makeRecipe(`bench-agent-memory-${target}`);
      expect(recipe, target).toContain('$(BUDGET)');
      expect(recipe, target).toContain('$(CONFIRM)');
    }
  });

  test('the clean target delegates and only removes worktrees with ALL=1', () => {
    const recipe = makeRecipe('bench-agent-memory-clean');
    expect(recipe).toContain('cd benchmarks/agent-memory');
    expect(recipe).toContain('bun run clean');
    expect(recipe).toContain('$(if $(filter 1,$(ALL)),--all,)');
  });

  test('the benchmark README documents the subproject install', () => {
    const readme = readFileSync(join(benchRoot, 'README.md'), 'utf8');
    expect(readme).toContain('cd benchmarks/agent-memory && bun install');
  });
});
