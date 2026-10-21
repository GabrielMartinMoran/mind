import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const ROOT = resolve(import.meta.dir, '..');
const DOCS = join(ROOT, 'docs');
const HISTORY = join(DOCS, 'history');

const LIVE_DOCS = [
  'agent-integration-matrix.md',
  'cognitive-memory-lifecycle.md',
  'search-benchmarks.md',
  'search-engine.md',
  'skill-first-distribution.md',
  'verification-harness.md',
];

const MOVED_REPORTS = [
  'search-audit.md',
  'search-optimization-plan.md',
  'search-optimization-report.md',
  'search-optimization-followup.md',
  'search-next-steps-research.md',
  'memory-recall-improvement-analysis.md',
  'cognitive-memory-lifecycle-report.md',
  'skill-first-distribution-report.md',
  'merge-readiness-report.md',
];

const RELEASE_NOTES = ['v1.5.0.md', 'v1.5.1.md', 'v1.6.0.md'];

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) files.push(full);
  }
  return files;
}

/** Extract markdown link targets, excluding images, URLs, anchors, and mail. */
function relativeLinks(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const links: string[] = [];
  const pattern = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1];
    if (!target) continue;
    if (
      target.startsWith('#') ||
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:') ||
      target.startsWith('/')
    ) {
      continue;
    }
    links.push(target);
  }
  return links;
}

function resolves(from: string, target: string): boolean {
  const path = decodeURIComponent(target.split('#')[0] ?? '').split('?')[0] ?? '';
  if (path === '') return true;
  return existsSync(resolve(dirname(from), path));
}

/** Collect broken links; missing files are skipped because some are generated. */
function collectLinkFailures(files: string[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const link of relativeLinks(file)) {
      if (!resolves(file, link)) {
        failures.push(`${relative(ROOT, file)} -> ${link}`);
      }
    }
  }
  return failures;
}

describe('documentation links', () => {
  test('every living doc is linked from docs/README.md', () => {
    const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
    for (const doc of LIVE_DOCS) {
      expect(index, `${doc} missing from docs/README.md`).toContain(`(${doc})`);
    }
  });

  test('living docs and history links resolve', () => {
    expect(collectLinkFailures(markdownFiles(DOCS))).toEqual([]);
  });

  test('root documentation links resolve', () => {
    const files = [
      join(ROOT, 'README.md'),
      join(ROOT, 'AGENTS.md'),
      join(ROOT, 'CHANGELOG.md'),
      join(ROOT, 'benchmarks/agent-memory/REPORT.md'),
      join(ROOT, 'benchmarks/agent-memory/README.md'),
    ];
    expect(collectLinkFailures(files)).toEqual([]);
  });

  test('an absent generated benchmark REPORT is skipped', () => {
    const absentReport = join(ROOT, 'benchmarks/agent-memory/REPORT.absent-for-test.md');
    expect(existsSync(absentReport)).toBe(false);
    expect(collectLinkFailures([absentReport])).toEqual([]);
    expect(
      collectLinkFailures([join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md'), absentReport])
    ).toEqual([]);
  });

  test('moved history reports carry a frozen banner', () => {
    const files = markdownFiles(HISTORY);
    expect(files.length).toBe(MOVED_REPORTS.length);
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      expect(lines[0] ?? '', `${relative(ROOT, file)} banner`).toMatch(
        /^> \*\*Historical report for feature .+\.\*\* Frozen on 2026-10-20\.$/
      );
      expect(lines[1] ?? '', `${relative(ROOT, file)} current-behavior line`).toMatch(
        /^> Current behavior: \[[^\]]+\]\(.+\.md\)\.$/
      );
    }
  });

  test('no temporal report remains in the docs root', () => {
    const rootMarkdown = readdirSync(DOCS)
      .filter(entry => entry.endsWith('.md'))
      .sort();
    expect(rootMarkdown).toEqual(['README.md', ...LIVE_DOCS].sort());
    for (const moved of MOVED_REPORTS) {
      expect(existsSync(join(DOCS, moved)), `${moved} still in docs root`).toBe(false);
    }
  });

  test('release notes remain in docs/release-notes', () => {
    const notes = readdirSync(join(DOCS, 'release-notes'))
      .filter(entry => entry.endsWith('.md'))
      .sort();
    expect(notes).toEqual(RELEASE_NOTES);
  });

  test('AGENTS.md carries the documentation policy without renumbering', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    const section5 = agents.indexOf('## 5. Keeping this document updated');
    const section6 = agents.indexOf('## 6. Documentation philosophy and maintenance');

    expect(section5).toBeGreaterThan(-1);
    expect(section6).toBeGreaterThan(section5);
    expect(agents.indexOf('## 6.')).toBe(section6);
    expect(agents.match(/^## 6\./gm)).toHaveLength(1);

    const policy = agents.slice(section6);
    const policyText = policy.replace(/\s+/g, ' ');
    expect(policy).toContain('### Source of truth and status vocabulary');
    expect(policy).toContain('- **Living**');
    expect(policy).toContain('- **Historical**');
    expect(policy).toContain('- **Session**');
    expect(policy).toContain('- **Unverified**');
    expect(policy).toContain('- **Not run**');
    expect(policy).toContain('### Living versus temporal documentation');
    expect(policy).toContain('### Update before you create');
    expect(policyText).toContain('Do not duplicate');
    expect(policyText).toContain('docs/README.md');
    expect(policyText).toContain('docs/history/<feature>/');
    expect(policyText).toContain('docs/release-notes/');
    expect(policyText).toContain('immutable; never move or rewrite them');
    expect(policyText).toContain('src/resources/protocols/mind-cognitive-protocol.md');
    expect(policy).toContain('### Historical evidence and benchmark reproducibility');
    expect(policyText).toContain('Benchmark numbers are host-specific');
  });
});
