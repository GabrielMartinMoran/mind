import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const ROOT = resolve(import.meta.dir, '..');
const DOCS = join(ROOT, 'docs');
const HISTORY = join(DOCS, 'history');
const RELEASE_NOTES = join(DOCS, 'release-notes');

const ROOT_DOCS = [
  join(ROOT, 'README.md'),
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CHANGELOG.md'),
  join(ROOT, 'benchmarks/agent-memory/README.md'),
];

/** Temporal report names are not living pages and must not sit in the docs root. */
const TEMPORAL_NAME =
  /(?:^|[-_])(?:audit|plan|report|analysis|followup|merge-readiness)(?:[-_.]|$)/i;

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) files.push(full);
  }
  return files;
}

/** Living pages are the root Markdown documents other than the index. */
function livingDocs(): string[] {
  return readdirSync(DOCS)
    .filter(entry => entry.endsWith('.md') && entry !== 'README.md')
    .sort();
}

/** Retained historical evidence is whatever remains under docs/history. */
function retainedReports(): string[] {
  if (!existsSync(HISTORY)) return [];
  return markdownFiles(HISTORY).sort();
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
    for (const doc of livingDocs()) {
      expect(index, `${doc} missing from docs/README.md`).toContain(`(${doc})`);
    }
  });

  test('every retained historical report is listed in docs/README.md', () => {
    const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
    for (const report of retainedReports()) {
      const target = relative(DOCS, report).split('\\').join('/');
      expect(index, `${target} missing from docs/README.md`).toContain(`(${target})`);
    }
  });

  test('living docs and retained history links resolve', () => {
    expect(collectLinkFailures(markdownFiles(DOCS))).toEqual([]);
  });

  test('root documentation links resolve', () => {
    const files = [...ROOT_DOCS, join(ROOT, 'benchmarks/agent-memory/REPORT.md')];
    expect(collectLinkFailures(files)).toEqual([]);
  });

  test('an absent generated benchmark REPORT is skipped', () => {
    const absentReport = join(ROOT, 'benchmarks/agent-memory/REPORT.absent-for-test.md');
    expect(existsSync(absentReport)).toBe(false);
    expect(collectLinkFailures([absentReport])).toEqual([]);
    expect(collectLinkFailures([...ROOT_DOCS, absentReport])).toEqual([]);
  });

  test('retained reports carry a frozen banner that points to current behavior', () => {
    for (const file of retainedReports()) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      expect(lines[0] ?? '', `${relative(ROOT, file)} banner`).toMatch(
        /^> \*\*Historical report for feature .+\.\*\* Frozen on \d{4}-\d{2}-\d{2}\.$/
      );
      const current = (lines[1] ?? '').match(/^> Current behavior: \[[^\]]+\]\((.+\.md)\)\.$/);
      expect(current, `${relative(ROOT, file)} current-behavior line`).not.toBeNull();
      const target = current?.[1] ?? '';
      const resolved = resolve(dirname(file), target);
      expect(
        resolved.startsWith(HISTORY + '/'),
        `${relative(ROOT, file)} points into history`
      ).toBe(false);
      expect(existsSync(resolved), `${relative(ROOT, file)} -> ${target}`).toBe(true);
    }
  });

  test('no temporal report remains in the docs root', () => {
    const rootMarkdown = readdirSync(DOCS)
      .filter(entry => entry.endsWith('.md') && entry !== 'README.md')
      .sort();
    expect(rootMarkdown.length).toBeGreaterThan(0);
    for (const entry of rootMarkdown) {
      expect(entry, `${entry} looks like a temporal report`).not.toMatch(TEMPORAL_NAME);
    }
  });

  test('documentation Markdown files are non-empty', () => {
    const files = [
      ...ROOT_DOCS,
      join(DOCS, 'README.md'),
      ...markdownFiles(DOCS),
      join(ROOT, 'benchmarks/agent-memory/REPORT.md'),
    ];
    for (const file of files) {
      if (!existsSync(file)) continue;
      expect(
        readFileSync(file, 'utf8').trim().length,
        `${relative(ROOT, file)} is empty`
      ).toBeGreaterThan(0);
    }
  });

  test('release notes exist and are non-empty without a fixed list', () => {
    const notes = readdirSync(RELEASE_NOTES).filter(entry => entry.endsWith('.md'));
    expect(notes.length).toBeGreaterThan(0);
    for (const entry of notes) {
      expect(
        readFileSync(join(RELEASE_NOTES, entry), 'utf8').trim().length,
        `${entry} is empty`
      ).toBeGreaterThan(0);
    }
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
    expect(policy).toContain('### Update before you create');
    expect(policyText).toContain('Do not duplicate');
    expect(policyText).toContain('docs/README.md');
    expect(policyText).toContain('docs/history/');
    expect(policyText).toContain('docs/release-notes/');
    expect(policyText).toContain('immutable; never move or rewrite them');
    expect(policyText).toContain('src/resources/protocols/mind-cognitive-protocol.md');
    expect(policyText).toContain('.pas/');
    expect(policyText).toMatch(/durable technical (?:value|evidence)/i);
    expect(policyText).toMatch(/not an automatic archive/i);
    expect(policyText).toMatch(/fixed list/i);
    expect(policyText).toMatch(/host-specific benchmark numbers/i);
    expect(policyText).toMatch(/no feature is required to produce a permanent report/i);
  });

  test('project AGENTS.md precedence is documented', () => {
    const normalized = (file: string) => readFileSync(file, 'utf8').replace(/\s+/g, ' ');

    const skillFirst = normalized(join(DOCS, 'skill-first-distribution.md'));
    expect(skillFirst).toMatch(/project AGENTS\.md precedence/i);
    expect(skillFirst).toContain('must point to the `mind-management` skill');
    expect(skillFirst).toContain('`system_instructions` fallback');
    expect(skillFirst).toContain('must not restate the Mind protocol');

    const matrix = normalized(join(DOCS, 'agent-integration-matrix.md'));
    expect(matrix).toContain('project `AGENTS.md` files after the global file');
    expect(matrix).toContain('Project files must point to the skill');
    expect(matrix).toContain('`system_instructions` fallback');
  });
});
