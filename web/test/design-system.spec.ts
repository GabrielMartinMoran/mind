import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const stylesDir = join(import.meta.dir, '../styles');
const componentsDir = join(stylesDir, 'components');

const newCssFiles = [
  'tokens.css',
  'base.css',
  'layout.css',
  'utilities.css',
  'animations.css',
  'main.css',
  ...readdirSync(componentsDir)
    .filter(name => name.endsWith('.css'))
    .map(name => join('components', name)),
];

function readStyle(name: string): string {
  return readFileSync(join(stylesDir, name), 'utf8');
}

function allNewCss(): string {
  return newCssFiles.map(readStyle).join('\n');
}

function readTokenTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const source = readStyle('tokens.css');
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;

  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name && value) {
      tokens.set(name, value.trim());
    }
  }

  return tokens;
}

function resolveHex(tokens: Map<string, string>, name: string): string {
  const raw = tokens.get(name);
  if (!raw) {
    throw new Error(`Missing token ${name}`);
  }

  const direct = /^#[0-9a-f]{6}$/i.exec(raw);
  if (direct) {
    return direct[0];
  }

  const alias = /^var\((--[a-z0-9-]+)\)$/i.exec(raw);
  if (alias?.[1]) {
    return resolveHex(tokens, alias[1]);
  }

  throw new Error(`Token ${name} does not resolve to a hex color: ${raw}`);
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = channelToLinear((value >> 16) & 0xff);
  const green = channelToLinear((value >> 8) & 0xff);
  const blue = channelToLinear(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

const tokens = readTokenTokens();

function ruleText(source: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*(?:,[^{}]*)?\\{`).exec(source);
  if (!match) return undefined;
  const start = match.index;
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  if (open === -1 || close === -1) return undefined;
  return source.slice(start, close + 1);
}

function ruleBlock(source: string, selector: string): string | undefined {
  const text = ruleText(source, selector);
  if (!text) return undefined;
  return text.slice(text.indexOf('{') + 1, -1);
}

function mediaBlock(source: string, query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  return match?.[1] ?? '';
}

const contrastPairs: Array<{ foreground: string; background: string; minimum: number }> = [
  { foreground: '--text-primary', background: '--bg-void', minimum: 4.5 },
  { foreground: '--text-secondary', background: '--surface-1', minimum: 4.5 },
  { foreground: '--text-quiet', background: '--surface-1', minimum: 4.5 },
  { foreground: '--accent', background: '--bg-void', minimum: 3 },
  { foreground: '--line-strong', background: '--surface-1', minimum: 3 },
  { foreground: '--line-strong', background: '--surface-3', minimum: 3 },
  { foreground: '--accent-ink', background: '--accent', minimum: 4.5 },
  { foreground: '--tier-1', background: '--surface-1', minimum: 3 },
  { foreground: '--tier-2', background: '--surface-1', minimum: 3 },
  { foreground: '--tier-3', background: '--surface-1', minimum: 3 },
];

describe('design system tokens', () => {
  test('required color pairs meet WCAG AA contrast', () => {
    for (const pair of contrastPairs) {
      const foreground = resolveHex(tokens, pair.foreground);
      const background = resolveHex(tokens, pair.background);
      const ratio = contrastRatio(foreground, background);

      expect(
        ratio,
        `${pair.foreground} on ${pair.background} should be >= ${pair.minimum} (was ${ratio.toFixed(2)})`
      ).toBeGreaterThanOrEqual(pair.minimum);
    }
  });

  test('exposes the approved type scale with integer weights', () => {
    for (const size of [12, 13, 14, 16, 20, 26, 34]) {
      expect(tokens.get(`--font-size-${size}`)).toBe(`${size}px`);
    }

    const weights = [
      '--font-weight-regular',
      '--font-weight-medium',
      '--font-weight-semibold',
      '--font-weight-bold',
    ];
    for (const weightToken of weights) {
      const raw = tokens.get(weightToken);
      expect(raw, `${weightToken} should be defined`).toBeDefined();
      expect(raw).toMatch(/^[0-9]+$/);
    }
  });

  test('defines focus and reduced-motion contracts', () => {
    expect(tokens.get('--focus-ring-width')).toBe('2px');
    expect(tokens.get('--focus-ring-offset')).toBe('2px');

    const css = allNewCss();
    expect(css).toMatch(/:focus-visible/);
    expect(css).not.toMatch(/outline\s*:\s*(none|0)\b/i);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe('design system layout contracts', () => {
  test('topbar actions share one height, padding, font size and radius', () => {
    const topbar = readStyle('components/topbar.css');
    const block = /\.topbar-actions \.topbar-action\s*\{([^}]*)\}/.exec(topbar)?.[1];

    expect(block, '.topbar-actions .topbar-action rule should exist').toBeDefined();
    expect(block).toMatch(/min-height:\s*36px/);
    expect(block).toMatch(/padding:\s*0 var\(--space-3\)/);
    expect(block).toMatch(/font-size:\s*var\(--font-size-13\)/);
    expect(block).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(block).toMatch(/align-items:\s*center/);
    expect(block).toMatch(/justify-content:\s*center/);
  });

  test('sidebar close control is hidden on desktop and revealed in the mobile drawer', () => {
    const nav = readStyle('components/nav.css');
    const baseBlock = /(?:^|\n)([^\n{}]*\.sidebar-close[^\n{}]*)\{([^}]*)\}/.exec(nav)?.[2];
    expect(baseBlock, '.sidebar-close base rule should exist').toBeDefined();
    expect(baseBlock).toMatch(/display:\s*none/);

    const media = /@media\s*\(max-width:\s*860px\)\s*\{([\s\S]*?)\n\}/.exec(nav)?.[1] ?? '';
    expect(media).toMatch(/\.sidebar-close\s*\{[^}]*display:\s*inline-flex/);
  });

  test('defines the 20px spacing token used by list and header rhythm', () => {
    expect(tokens.get('--space-5')).toBe('20px');
  });

  test('quiet and outlined variants stay unfilled while confirmation danger stays solid', () => {
    const buttons = readStyle('components/buttons.css');

    const quiet = ruleBlock(buttons, '.btn-quiet') ?? '';
    expect(quiet, '.btn-quiet rule should exist').not.toBe('');
    expect(quiet).toMatch(/background:\s*transparent/);
    expect(quiet).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(quiet).toMatch(/border-color:\s*var\(--line\)/);

    const outlinedDanger = ruleBlock(buttons, '.btn-danger-outline') ?? '';
    expect(outlinedDanger, '.btn-danger-outline rule should exist').not.toBe('');
    expect(outlinedDanger).toMatch(/background:\s*transparent/);
    expect(outlinedDanger).toMatch(/color:\s*var\(--danger\)/);
    expect(outlinedDanger).toMatch(/border-color:\s*var\(--danger\)/);

    const solidDanger = ruleBlock(buttons, '.btn-danger') ?? '';
    expect(solidDanger).toMatch(/background:\s*var\(--danger\)/);
  });

  test('topbar actions compact to 36px icon controls with hidden labels at phone widths', () => {
    const topbar = readStyle('components/topbar.css');
    const phone = mediaBlock(topbar, 'max-width: 600px');

    expect(phone, 'phone topbar media block should exist').not.toBe('');
    expect(phone).toMatch(/\.topbar-actions \.topbar-action\s*\{[^}]*width:\s*36px/);
    expect(phone).toMatch(/\.topbar-actions \.topbar-action\s*\{[^}]*min-width:\s*36px/);
    expect(phone).toMatch(/\.topbar-actions \.topbar-action\s*\{[^}]*padding:\s*0/);
    expect(phone).toMatch(/\.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  });

  test('identity row keeps the title and New memory control on one line', () => {
    const shell = readStyle('components/shell.css');

    const identity = ruleBlock(shell, '.space-identity') ?? '';
    expect(identity, '.space-identity rule should exist').not.toBe('');
    expect(identity).toMatch(/display:\s*flex/);
    expect(identity).toMatch(/align-items:\s*center/);
    expect(identity).toMatch(/justify-content:\s*space-between/);
    expect(identity).toMatch(/flex-wrap:\s*nowrap/);
    expect(identity).toMatch(/min-width:\s*0/);

    const title = ruleBlock(shell, '.space-identity #space-title') ?? '';
    expect(title, '.space-identity #space-title rule should exist').not.toBe('');
    expect(title).toMatch(/flex:\s*1/);
    expect(title).toMatch(/min-width:\s*0/);
  });

  test('view toggle keeps its text labels visible beside the icon', () => {
    const nav = readStyle('components/nav.css');
    const label = ruleBlock(nav, '.view-toggle .btn-label') ?? '';

    expect(label, '.view-toggle .btn-label rule should exist').not.toBe('');
    expect(label).not.toMatch(/display:\s*none/);
    expect(label).not.toMatch(/position:\s*absolute/);
  });

  test('wide refinements reuse tokens and never hide the Delete space label', () => {
    const shell = readStyle('components/shell.css');
    const wide = mediaBlock(shell, 'min-width: 1360px');

    expect(wide, 'min-width: 1360px block should exist').not.toBe('');

    // Wide spacing is an existing token step, not a new palette or hue.
    expect(wide).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(wide).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
    expect(wide).toMatch(/var\(--space-3\)/);

    // Destructive triggers keep their visible label at every width, including
    // the compact phone rules that shrink the identity action to an icon.
    expect(shell).not.toMatch(
      /#btn-delete-space[^{]*\.btn-label[^{]*\{[^}]*(?:display:\s*none|clip-path)/
    );
  });
});

describe('graph interaction and space spacing contracts', () => {
  test('graph map chrome disables text selection but the memory table stays selectable', () => {
    const graph = readStyle('components/graph.css');

    const mapRule = ruleText(graph, '.graph-canvas-wrap');
    expect(mapRule, '.graph-canvas-wrap rule should exist').toBeDefined();
    expect(mapRule).toMatch(/-webkit-user-select:\s*none/);
    expect(mapRule).toMatch(/(?<!-webkit-)user-select:\s*none/);

    for (const selector of ['.graph-node', '.graph-label', '.graph-status-bar', '.graph-toolbar']) {
      // Node/label/control selectors live in the shared rule, so assert the
      // shared rule covers them rather than requiring a literal own rule.
      expect(mapRule, `${selector} should be covered by the no-select rule`).toContain(selector);
    }

    const graphViewBlock = ruleBlock(graph, '.graph-view');
    expect(graphViewBlock ?? '').not.toMatch(/user-select/);

    const memoryListBlock = ruleBlock(graph, '.graph-memory-list');
    expect(memoryListBlock, '.graph-memory-list rule should exist').toBeDefined();
    expect(memoryListBlock).not.toMatch(/user-select/);
  });

  test('graph selection highlights incident edges, mutes the rest and emphasizes neighbors', () => {
    const graph = readStyle('components/graph.css');

    const incident = ruleBlock(graph, '.graph-edge.is-incident') ?? '';
    expect(incident, '.graph-edge.is-incident rule should exist').not.toBe('');
    expect(incident).toMatch(/stroke:\s*var\(--accent\)/);
    expect(incident).toMatch(/stroke-width:\s*(?:2\.[5-9]|[3-9])(?:px)?\s*;/);
    expect(incident).toMatch(/stroke-opacity:\s*1(?:\.0)?\s*;/);

    const muted = ruleBlock(graph, '.graph-edge.is-muted') ?? '';
    expect(muted, '.graph-edge.is-muted rule should exist').not.toBe('');
    const mutedOpacity = /stroke-opacity:\s*(0?\.\d+)\s*;/.exec(muted)?.[1];
    expect(mutedOpacity).toBeDefined();
    const opacity = Number(mutedOpacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThanOrEqual(0.15);

    const neighbor = ruleBlock(graph, '.graph-node.is-neighbor .graph-node-dot') ?? '';
    expect(neighbor, 'neighbor ring rule should exist').not.toBe('');
    expect(neighbor).toMatch(/stroke:\s*var\(--accent\)/);
  });

  test('memory panel backdrop is a light scrim so the highlighted map stays visible', () => {
    const panel = readStyle('components/memory-panel.css');
    const backdrop = ruleBlock(panel, '#memory-panel::backdrop') ?? '';
    expect(backdrop, '#memory-panel::backdrop rule should exist').not.toBe('');

    const alpha = /rgb\(\s*3\s+6\s+12\s*\/\s*([0-9.]+)%\s*\)/.exec(backdrop)?.[1];
    expect(alpha).toBeDefined();
    expect(Number(alpha) / 100).toBeLessThan(0.4);
  });

  test('space detail keeps content clear of the viewport edges', () => {
    const detailBlock = ruleBlock(readStyle('layout.css'), '#space-detail');
    expect(detailBlock, '#space-detail rule should exist').toBeDefined();
    expect(detailBlock).toMatch(/padding:\s*0 16px 16px/);

    const headerBlock = ruleBlock(
      readStyle('components/shell.css'),
      '#space-detail > .panel-header'
    );
    expect(headerBlock, '#space-detail > .panel-header rule should exist').toBeDefined();
    expect(headerBlock).toMatch(/padding:\s*var\(--space-4\) 0/);

    const listBlock = ruleBlock(readStyle('components/memory-list.css'), '#list-view');
    expect(listBlock, '#list-view rule should exist').toBeDefined();
    expect(listBlock).toMatch(/padding:\s*var\(--space-3\) 0 var\(--space-5\)/);
  });
});

describe('space card tier spectrum contracts', () => {
  const cards = readStyle('components/cards.css');

  test('spectrum bar is a 6px pill with a neutral track and tier-colored segments', () => {
    const spectrum = ruleBlock(cards, '.space-tier-spectrum') ?? '';
    expect(spectrum, '.space-tier-spectrum rule should exist').not.toBe('');
    expect(spectrum).toMatch(/display:\s*flex/);
    expect(spectrum).toMatch(/height:\s*6px/);
    expect(spectrum).toMatch(/overflow:\s*hidden/);
    expect(spectrum).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(spectrum).toMatch(/background:\s*var\(--surface-3\)/);

    for (const tier of [1, 2, 3]) {
      const segment = ruleBlock(cards, `.space-tier-segment.t${tier}`) ?? '';
      expect(segment, `.space-tier-segment.t${tier} rule should exist`).not.toBe('');
      expect(segment).toMatch(new RegExp(`background:\\s*var\\(--tier-${tier}\\)`));
    }

    const segment = ruleBlock(cards, '.space-tier-segment') ?? '';
    expect(segment, '.space-tier-segment rule should exist').not.toBe('');
    expect(segment).toMatch(/min-width:\s*0/);
  });

  test('counts use tabular numerals and zero counts stay quiet', () => {
    const counts = ruleBlock(cards, '.space-tier-counts') ?? '';
    expect(counts, '.space-tier-counts rule should exist').not.toBe('');
    expect(counts).toMatch(/flex-wrap:\s*wrap/);
    expect(counts).toMatch(/font-size:\s*var\(--font-size-12\)/);
    expect(counts).toMatch(/font-variant-numeric:\s*tabular-nums/);

    const zero = ruleBlock(cards, '.space-tier-count.is-zero') ?? '';
    expect(zero, '.space-tier-count.is-zero rule should exist').not.toBe('');
    expect(zero).toMatch(/color:\s*var\(--text-quiet\)/);
  });

  test('tier counts render as subtle passive chips with an emphasized number', () => {
    const chip = ruleBlock(cards, '.space-tier-count') ?? '';
    expect(chip, '.space-tier-count rule should exist').not.toBe('');
    expect(chip).toMatch(/border:\s*1px solid color-mix\(in srgb, currentColor/);
    expect(chip).toMatch(/background:\s*color-mix\(in srgb, currentColor/);
    expect(chip).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(chip).toMatch(/padding:\s*1px\s+var\(--space-2\)/);
    expect(chip).not.toMatch(/cursor:\s*pointer/);

    const label = ruleBlock(cards, '.space-tier-label') ?? '';
    expect(label, '.space-tier-label rule should exist').not.toBe('');

    const value = ruleBlock(cards, '.space-tier-value') ?? '';
    expect(value, '.space-tier-value rule should exist').not.toBe('');
    expect(value).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);

    const zero = ruleBlock(cards, '.space-tier-count.is-zero') ?? '';
    expect(zero).toMatch(/background:\s*var\(--surface-2\)/);
    expect(zero).toMatch(/border-color:\s*var\(--line\)/);
  });

  test('chip numbers stay tabular and labels read quieter than the number', () => {
    const value = ruleBlock(cards, '.space-tier-value') ?? '';
    expect(value, '.space-tier-value rule should exist').not.toBe('');
    expect(value).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(value).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);

    const label = ruleBlock(cards, '.space-tier-label') ?? '';
    expect(label, '.space-tier-label rule should exist').not.toBe('');
    expect(label).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(label).toMatch(/font-weight:\s*var\(--font-weight-medium\)/);
    expect(label).not.toMatch(/opacity/);

    const zeroLabel = ruleBlock(cards, '.space-tier-count.is-zero .space-tier-label') ?? '';
    expect(zeroLabel, 'zero-chip label rule should exist').not.toBe('');
    expect(zeroLabel).toMatch(/color:\s*inherit/);
  });

  test('chip tint and border stay subtle instead of saturated badges', () => {
    const chip = ruleBlock(cards, '.space-tier-count') ?? '';
    expect(chip, '.space-tier-count rule should exist').not.toBe('');

    const tint = Number(/background:\s*color-mix\(in srgb, currentColor (\d+)%/.exec(chip)?.[1]);
    expect(tint).toBeGreaterThan(0);
    expect(tint).toBeLessThanOrEqual(15);

    const borderAlpha = Number(
      /border:\s*1px solid color-mix\(in srgb, currentColor (\d+)%/.exec(chip)?.[1]
    );
    expect(borderAlpha).toBeGreaterThan(0);
    expect(borderAlpha).toBeLessThanOrEqual(40);

    expect(chip).toMatch(/white-space:\s*nowrap/);
    expect(chip).toMatch(/line-height:\s*1\.3/);
  });

  test('footer sits at the bottom and tags truncate without widening the card', () => {
    const meta = ruleBlock(cards, '.space-card-meta') ?? '';
    expect(meta).toMatch(/margin-top:\s*auto/);
    expect(meta).toMatch(/justify-content:\s*space-between/);

    const tags = ruleBlock(cards, '.space-card-tags') ?? '';
    expect(tags).toMatch(/min-width:\s*0/);
    expect(tags).toMatch(/overflow:\s*hidden/);

    const tag = ruleBlock(cards, '.space-card-tag') ?? '';
    expect(tag).toMatch(/text-overflow:\s*ellipsis/);

    const count = ruleBlock(cards, '.space-card-count') ?? '';
    expect(count).toMatch(/white-space:\s*nowrap/);
  });

  test('cards fill their grid row so rows keep equal heights', () => {
    const card = ruleBlock(cards, '.space-card') ?? '';
    expect(card).toMatch(/height:\s*100%/);
  });
});

describe('command icon system', () => {
  test('shell markup references the local sprite for every decorative icon', () => {
    const index = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
    const svgs = Array.from(index.matchAll(/<svg\b[\s\S]*?<\/svg>/gi), match => match[0]);

    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg, 'icon should reference the local sprite').toMatch(
        /<use href="\/assets\/icons\.svg#icon-[a-z0-9-]+"><\/use>/
      );
      expect(svg, 'no inline icon artwork').not.toMatch(
        /<(?:path|circle|rect|line|polyline|polygon)\b/i
      );
      expect(svg, 'no hard-coded icon color').not.toMatch(/(?:fill|stroke)="#[0-9a-f]{3,8}"/i);
      expect(svg, 'decorative icon').toMatch(/aria-hidden="true"/);
      expect(svg, 'icon not focusable').toMatch(/focusable="false"/);
    }
  });

  test('runtime views delegate command icons to the shared helper', () => {
    const cases: Array<{ file: string; importFrom: string; allowsSvg: boolean }> = [
      { file: 'views/graph-view.js', importFrom: './icon.js', allowsSvg: true },
      { file: 'views/logs-view.js', importFrom: './icon.js', allowsSvg: false },
      { file: 'app.js', importFrom: './views/icon.js', allowsSvg: false },
    ];

    for (const entry of cases) {
      const source = readFileSync(join(import.meta.dir, '..', 'src', entry.file), 'utf8');
      expect(source, `${entry.file} imports the shared icon helper`).toContain(
        `from '${entry.importFrom}'`
      );
      expect(source, `${entry.file} has no inline hex icon artwork`).not.toMatch(
        /<(?:path|circle|rect|line)\b[^>]*(?:fill|stroke)="#[0-9a-f]{3,8}"/i
      );
      if (!entry.allowsSvg) {
        expect(source, `${entry.file} builds no inline SVG markup`).not.toMatch(/<svg\b/);
      }
    }
  });

  test('toast severity icons use semantic color tokens instead of hard-coded hues', () => {
    const feedback = readStyle('components/feedback.css');

    const base = ruleBlock(feedback, '.toast-icon') ?? '';
    expect(base, '.toast-icon rule should exist').not.toBe('');
    expect(base).toMatch(/width:\s*18px/);
    expect(base).toMatch(/height:\s*18px/);

    const severities: Array<[string, string]> = [
      ['success', '--success'],
      ['error', '--danger'],
      ['warning', '--warning'],
    ];
    for (const [type, token] of severities) {
      const block = ruleBlock(feedback, `.toast-icon-${type}`) ?? '';
      expect(block, `.toast-icon-${type} rule should exist`).not.toBe('');
      expect(block).toMatch(new RegExp(`color:\\s*var\\(${token}\\)`));
    }
  });
});

describe('design system CSS hygiene', () => {
  test('interactive component boundaries use the strong line token', () => {
    const rules: Array<{ file: string; selector: string }> = [
      { file: 'components/cards.css', selector: '.card' },
      { file: 'components/cards.css', selector: '.memory-card' },
      { file: 'components/forms.css', selector: '.chip' },
    ];

    for (const rule of rules) {
      const source = readStyle(rule.file);
      const block = new RegExp(`${rule.selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(
        source
      )?.[1];

      expect(block, `${rule.selector} rule should exist in ${rule.file}`).toBeDefined();
      expect(block).toMatch(/border\s*:\s*1px solid var\(--line-strong\)/);
      expect(block).not.toMatch(/border\s*:\s*1px solid var\(--line\)(?!-strong)/);
    }
  });

  test('has no ambient pulse, glow or breathe keyframes', () => {
    const css = allNewCss();
    const keyframes = Array.from(
      css.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)/g),
      match => match[1] ?? ''
    );

    expect(keyframes.length).toBeGreaterThan(0);
    for (const name of keyframes) {
      expect(name, `ambient keyframe ${name}`).not.toMatch(/(neon|glow|breathe)/i);
    }
  });

  test('has no glassmorphism backdrop filters', () => {
    expect(allNewCss()).not.toMatch(/backdrop-filter/i);
  });
});
