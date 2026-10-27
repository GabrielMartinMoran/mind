// Experiment A — offline analysis pass.
//
// Re-renders `report.md` and writes `analysis.json` from an existing
// `results.json` (no server, no DB, no network). Keeps the gains/losses,
// zero-result and recommendation sections reproducible without re-running the
// 120-probe replay.
//
// Usage: bun run experiments/query-strategies/analyze.ts [--dir <reports-dir>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAnalysis, renderReport, type CrossConvResult, type ResultsFile } from './run';

function resolveDir(argv: readonly string[]): string {
  const index = argv.indexOf('--dir');
  if (index >= 0 && argv[index + 1]) return resolvePath(argv[index + 1]!);
  return join(import.meta.dir, '..', 'REPORTS', 'query-strategies');
}

function resolvePath(path: string): string {
  return path.startsWith('/') ? path : join(import.meta.dir, path);
}

const dir = resolveDir(process.argv.slice(2));
const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as ResultsFile;
const crossConvPath = join(dir, 'cross-conv.json');
const crossConv = existsSync(crossConvPath)
  ? (JSON.parse(readFileSync(crossConvPath, 'utf8')) as CrossConvResult)
  : null;
const report = renderReport(results, crossConv);
writeFileSync(join(dir, 'report.md'), report);
writeFileSync(join(dir, 'analysis.json'), `${JSON.stringify(buildAnalysis(results), null, 2)}\n`);
process.stdout.write(`analysis written → ${dir}\n`);
