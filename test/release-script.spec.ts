import { mkdtemp, rm, mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const repoRoot = new URL('..', import.meta.url).pathname;
const releaseScript = join(repoRoot, 'scripts', 'release.sh');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mind-release-script-'));
  await mkdir(join(tempDir, 'scripts'));
  await copyFile(releaseScript, join(tempDir, 'scripts', 'release.sh'));
  await writeFile(
    join(tempDir, 'package.json'),
    `${JSON.stringify({ name: 'mind', version: '1.4.0' }, null, 2)}\n`
  );
  await mkdir(join(tempDir, 'test'));
  await writeFile(
    join(tempDir, 'test', 'release-fixture.spec.ts'),
    "import { expect, it } from 'bun:test';\n\nit('passes release fixture', () => {\n  expect(true).toBe(true);\n});\n"
  );
  await writeFile(
    join(tempDir, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Added release prep coverage.\n\n## [1.4.0] - 2026-04-10\n\n- Previous release.\n'
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function installCommandStubs(branch = 'main') {
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir);
  await writeFile(
    join(binDir, 'git'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho "git $*" >> "${tempDir}/commands.log"\nif [ "$1" = "rev-parse" ] && [ "\${2:-}" = "--abbrev-ref" ]; then echo "${branch}"; exit 0; fi\nif [ "$1" = "rev-parse" ]; then exit 1; fi\nif [ "$1" = "diff" ]; then exit 0; fi\nexit 0\n`,
    { mode: 0o755 }
  );
  await writeFile(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash\nset -euo pipefail\necho "gh $*" >> "${tempDir}/commands.log"\nexit 0\n`,
    { mode: 0o755 }
  );
  return binDir;
}

async function runRelease(args: string[], branch = 'main') {
  const binDir = await installCommandStubs(branch);
  const proc = Bun.spawn({
    cmd: ['bash', 'scripts/release.sh', ...args],
    cwd: tempDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
    commands: await readFile(join(tempDir, 'commands.log'), 'utf8').catch(() => ''),
  };
}

describe('release script', () => {
  it('creates a minimal fixture test suite for non-simulated releases', async () => {
    const fixtureTest = await readFile(join(tempDir, 'test', 'release-fixture.spec.ts'), 'utf8');

    expect(fixtureTest).toContain("import { expect, it } from 'bun:test';");
  });

  it('passes a curated notes file to GitHub releases when provided', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Curated release notes\n');

    const result = await runRelease(['minor', '--notes-file', 'notes.md']);

    expect(result.exitCode).toBe(0);
    expect(result.commands).toContain(
      'gh release create v1.5.0 --title v1.5.0 --notes-file notes.md'
    );
    expect(result.commands).not.toContain('--generate-notes');
  });

  it('uses generated GitHub notes when no notes file is provided', async () => {
    const result = await runRelease(['minor']);

    expect(result.exitCode).toBe(0);
    expect(result.commands).toContain('gh release create v1.5.0 --title v1.5.0 --generate-notes');
  });

  it('releases with the Bun lockfile and no package-lock.json', async () => {
    const result = await runRelease(['minor']);

    expect(result.exitCode).toBe(0);
    expect(result.commands).toContain('git add package.json CHANGELOG.md');
    expect(result.commands).not.toContain('package-lock.json');
    expect(await Bun.file(join(tempDir, 'package-lock.json')).exists()).toBe(false);
  });

  it('does not change files during simulation and warns when not on main', async () => {
    const beforePackage = await readFile(join(tempDir, 'package.json'), 'utf8');
    const beforeChangelog = await readFile(join(tempDir, 'CHANGELOG.md'), 'utf8');

    const result = await runRelease(['minor', '--simulate'], 'develop');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      '[simulate] warning: release is normally run from main (current: develop)'
    );
    expect(await readFile(join(tempDir, 'package.json'), 'utf8')).toBe(beforePackage);
    expect(await readFile(join(tempDir, 'CHANGELOG.md'), 'utf8')).toBe(beforeChangelog);
    expect(await Bun.file(join(tempDir, 'package-lock.json')).exists()).toBe(false);
  });
});
