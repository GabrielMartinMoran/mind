import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { installDom } from './helpers/dom';

const repoRoot = join(import.meta.dir, '../..');
const packageJsonPath = join(repoRoot, 'package.json');
const jsconfigPath = join(repoRoot, 'web/jsconfig.json');
const workflowPath = join(repoRoot, '.github/workflows/main.yml');
const indexHtmlPath = join(repoRoot, 'web/public/index.html');
const vendorDir = join(repoRoot, 'web/assets/vendor');

describe('web infrastructure contract', () => {
  test('root scripts expose web typechecking and typecheck runs both projects', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const scripts = packageJson.scripts ?? {};

    expect(typeof scripts['typecheck:web']).toBe('string');
    expect(scripts['typecheck:web']).toContain('web/jsconfig.json');
    expect(scripts.typecheck).toContain('typecheck:web');
    expect(packageJson.devDependencies['happy-dom']).toBeTruthy();
  });

  test('web/jsconfig.json checks web sources and web tests', () => {
    expect(existsSync(jsconfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(jsconfigPath, 'utf8'));
    const options = config.compilerOptions ?? {};

    expect(options.allowJs).toBe(true);
    expect(options.checkJs).toBe(true);
    expect(options.noEmit).toBe(true);
    expect(options.lib).toEqual(expect.arrayContaining(['ES2022', 'DOM']));
    expect(options.module).toBe('ESNext');
    expect(options.moduleResolution).toBe('Bundler');
    // Paths are relative to web/, so these cover web/src and web/test.
    expect(config.include).toEqual(expect.arrayContaining(['src/**/*.js', 'test/**/*.ts']));
  });

  test('CI runs the root typecheck (root + web)', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('bun run typecheck');
  });

  test('the shell loads marked from a local vendored asset', () => {
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const markedScript = indexHtml.match(/<script[^>]+src="([^"]*marked[^"]*)"/i);

    expect(markedScript?.[1]).toBe('/assets/vendor/marked.min.js');
    expect(indexHtml).not.toMatch(/https?:\/\/[^"']*marked/i);
  });

  test('vendored marked asset exists with pinned version and license', () => {
    const assetPath = join(vendorDir, 'marked.min.js');
    const licensePath = join(vendorDir, 'LICENSE.marked');

    expect(existsSync(assetPath)).toBe(true);
    expect(existsSync(licensePath)).toBe(true);

    const asset = readFileSync(assetPath, 'utf8');
    const license = readFileSync(licensePath, 'utf8');

    expect(asset).toContain('marked v18.1.1');
    expect(license.toLowerCase()).toContain('mit license');
  });
});

describe('DOM test harness', () => {
  test('renders nodes and exposes textContent and attributes', () => {
    const { document, cleanup } = installDom();

    try {
      const card = document.createElement('article');
      card.className = 'memory-card';
      card.setAttribute('data-tier', '2');
      card.textContent = 'auth-jwt';

      document.body.appendChild(card);

      expect(document.body.textContent).toBe('auth-jwt');
      expect(card.className).toBe('memory-card');
      expect(card.getAttribute('data-tier')).toBe('2');
    } finally {
      cleanup();
    }
  });

  test('cleanup restores the previous globals', () => {
    const previousDocument = globalThis.document;
    const { cleanup } = installDom();

    cleanup();

    expect(globalThis.document).toBe(previousDocument);
  });
});
