import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { ICON_NAMES, ICON_SPRITE_PATH, createIcon } from '../src/views/icon.js';

import { installDom } from './helpers/dom';

const repoRoot = join(import.meta.dir, '../..');
const spritePath = join(repoRoot, 'web/assets/icons.svg');
const licensePath = join(repoRoot, 'web/assets/vendor/LICENSE.lucide');
const helperPath = join(repoRoot, 'web/src/views/icon.js');

/**
 * Contract copied from the approved plan's `icon_map`. It is intentionally
 * independent of the implementation so a new sprite symbol or a renamed icon
 * fails loudly instead of silently drifting.
 */
const EXPECTED_ICON_NAMES = [
  'menu',
  'x',
  'arrow-left',
  'folder-plus',
  'file-text',
  'layout-grid',
  'file-plus',
  'trash-2',
  'list',
  'network',
  'tag',
  'filter-x',
  'check',
  'arrow-up',
  'arrow-down',
  'pin',
  'pencil',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'zoom-in',
  'zoom-out',
  'maximize',
  'rotate-ccw',
  'circle-check',
  'circle-alert',
  'triangle-alert',
] as const;

function readSprite(): string {
  return readFileSync(spritePath, 'utf8');
}

function parseSvg(source: string): Document {
  const harness = installDom();
  return new harness.window.DOMParser().parseFromString(
    source,
    'image/svg+xml'
  ) as unknown as Document;
}

describe('Lucide icon sprite', () => {
  test('exports the approved icon allowlist and nothing else', () => {
    expect(Object.isFrozen(ICON_NAMES)).toBe(true);
    expect([...ICON_NAMES]).toEqual([...EXPECTED_ICON_NAMES]);
    expect(ICON_SPRITE_PATH).toBe('/assets/icons.svg');
  });

  test('defines exactly one prefixed symbol per allowlisted icon', () => {
    const document = parseSvg(readSprite());
    const symbols = Array.from(document.querySelectorAll('symbol'));
    const ids = symbols.map(symbol => symbol.getAttribute('id'));

    expect(new Set(ids)).toEqual(new Set(EXPECTED_ICON_NAMES.map(name => `icon-${name}`)));
    expect(ids).toHaveLength(EXPECTED_ICON_NAMES.length);
  });

  test('every symbol follows the 24px Lucide stroke contract', () => {
    const document = parseSvg(readSprite());
    const symbols = Array.from(document.querySelectorAll('symbol'));

    for (const symbol of symbols) {
      const id = symbol.getAttribute('id');
      expect(symbol.getAttribute('viewBox'), `${id} viewBox`).toBe('0 0 24 24');
      expect(symbol.getAttribute('fill'), `${id} fill`).toBe('none');
      expect(symbol.getAttribute('stroke'), `${id} stroke`).toBe('currentColor');
      expect(symbol.getAttribute('stroke-width'), `${id} stroke-width`).toBe('2');
      expect(symbol.getAttribute('stroke-linecap'), `${id} stroke-linecap`).toBe('round');
      expect(symbol.getAttribute('stroke-linejoin'), `${id} stroke-linejoin`).toBe('round');
      expect(symbol.children.length, `${id} artwork`).toBeGreaterThan(0);
    }
  });

  test('sprite is self-contained and uses only currentColor or none', () => {
    const source = readSprite();

    expect(source).not.toMatch(/<script\b/i);
    expect(source).not.toMatch(/<image\b/i);
    expect(source).not.toMatch(/\b(?:href|xlink:href)\s*=/i);
    expect(source).not.toMatch(/url\(/i);
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/i);

    const document = parseSvg(source);
    expect(document.querySelector('svg')).not.toBeNull();
  });
});

describe('createIcon helper', () => {
  test('returns a decorative SVG that references the local sprite', () => {
    const { document, cleanup } = installDom();

    try {
      const icon = createIcon('menu', { document });

      expect(icon.tagName.toLowerCase()).toBe('svg');
      expect(icon.getAttribute('class')).toBe('icon');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(icon.getAttribute('fill')).toBe('none');
      expect(icon.getAttribute('stroke')).toBe('currentColor');
      expect(icon.getAttribute('stroke-width')).toBe('2');

      const use = icon.querySelector('use');
      expect(use?.getAttribute('href')).toBe('/assets/icons.svg#icon-menu');
      expect(use?.getAttribute('xlink:href')).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('applies the compact size variant without changing the accessible contract', () => {
    const { document, cleanup } = installDom();

    try {
      const compact = createIcon('x', { document, size: 'sm' });
      expect(compact.getAttribute('class')).toBe('icon icon-sm');
      expect(compact.getAttribute('aria-hidden')).toBe('true');
      expect(compact.getAttribute('focusable')).toBe('false');

      const regular = createIcon('x', { document, size: 'md' });
      expect(regular.getAttribute('class')).toBe('icon');
    } finally {
      cleanup();
    }
  });

  test('rejects unknown icon names and sizes without interpolating them', () => {
    const { document, cleanup } = installDom();
    const before = document.body.childElementCount;

    try {
      expect(() => createIcon('not-an-icon', { document })).toThrow(RangeError);
      expect(() => createIcon('<script>alert(1)</script>', { document })).toThrow(RangeError);
      expect(() => createIcon('x', { document, size: 'huge' as never })).toThrow(RangeError);
      expect(document.body.childElementCount).toBe(before);
      expect(document.body.innerHTML).not.toContain('script');
    } finally {
      cleanup();
    }
  });

  test('never builds markup with innerHTML', () => {
    const source = readFileSync(helperPath, 'utf8');
    expect(source).not.toContain('innerHTML');
    // The only absolute URL is the SVG XML namespace, never a network request.
    expect(source).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});

describe('icon licensing', () => {
  test('records the pinned Lucide source, version, selected symbols and upstream notices', () => {
    const license = readFileSync(licensePath, 'utf8');

    expect(license).toContain('lucide-static v0.547.0');
    expect(license).toContain('https://github.com/lucide-icons/lucide');
    expect(license).toContain('ISC License');
    expect(license).toContain('The MIT License (MIT)');
    expect(license).toContain('Cole Bemis');
    expect(license).toContain('Lucide Contributors');

    for (const name of EXPECTED_ICON_NAMES) {
      expect(license, `license should list ${name}`).toContain(name);
    }
  });
});
