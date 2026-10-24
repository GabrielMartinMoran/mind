import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repoRoot = join(import.meta.dir, '../..');
const indexHtmlPath = join(repoRoot, 'web/public/index.html');
const iconHelperPath = join(repoRoot, 'web/src/views/icon.js');
const iconSpritePath = join(repoRoot, 'web/assets/icons.svg');
const iconLicensePath = join(repoRoot, 'web/assets/vendor/LICENSE.lucide');
const packageJsonPath = join(repoRoot, 'package.json');

function getAssetAttributeValues(indexHtml: string, attributeName: 'href' | 'src'): string[] {
  const pattern = new RegExp(`${attributeName}="([^"]+)"`, 'g');
  return Array.from(indexHtml.matchAll(pattern), match => match[1]).filter(
    (value): value is string => typeof value === 'string'
  );
}

describe('web index asset paths', () => {
  test('uses root-absolute paths for local assets so deep-route reloads still load resources', () => {
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const hrefValues = getAssetAttributeValues(indexHtml, 'href');
    const srcValues = getAssetAttributeValues(indexHtml, 'src');

    expect(hrefValues).toContain('/assets/logo.svg');
    expect(hrefValues).toContain('/styles/main.css');

    expect(srcValues).toContain('/assets/logo.svg');
    expect(srcValues).toContain('/src/app.js');
  });

  test('ships the icon sprite and license in the static asset tree', () => {
    expect(existsSync(iconSpritePath)).toBe(true);
    expect(existsSync(iconLicensePath)).toBe(true);

    // The server maps `/assets/...` to `web/assets/...`; a root-absolute use
    // href therefore resolves on deep routes such as /spaces/projects%2Fmind.
    expect(existsSync(join(repoRoot, 'web', 'assets', 'icons.svg'))).toBe(true);

    const helper = readFileSync(iconHelperPath, 'utf8');
    expect(helper).toContain("'/assets/icons.svg'");
    // The only absolute URL is the SVG XML namespace, never a network request.
    expect(helper).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });

  test('adds no icon runtime dependency or remote icon request', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(Object.keys(dependencies).some(name => /lucide/i.test(name))).toBe(false);

    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    expect(indexHtml).not.toMatch(/https?:\/\/[^"']*lucide/i);
  });
});
