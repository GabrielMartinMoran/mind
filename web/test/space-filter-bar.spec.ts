import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { installDom } from './helpers/dom';

const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');
const shellCss = readFileSync(join(import.meta.dir, '../styles/components/shell.css'), 'utf8');
const utilitiesCss = readFileSync(join(import.meta.dir, '../styles/utilities.css'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = shellCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

function mediaBlock(query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = shellCss.match(new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

function loadShell(): { document: Document; cleanup: () => void } {
  const harness = installDom();
  const document = new harness.window.DOMParser().parseFromString(indexHtml, 'text/html');
  return { document: document as unknown as Document, cleanup: harness.cleanup };
}

describe('static space filter bar', () => {
  test('is declared exactly once inside the space header', () => {
    const { document, cleanup } = loadShell();
    try {
      const bars = document.querySelectorAll('#space-filter-bar');
      expect(bars).toHaveLength(1);

      const bar = bars[0]!;
      expect(bar.closest('#space-detail > .panel-header')).not.toBeNull();
      expect(bar.querySelector('#space-search')).not.toBeNull();
      expect(bar.querySelector('select#space-filter-tag')).not.toBeNull();
      expect(bar.querySelector('input#space-filter-tag')).toBeNull();
      expect(bar.querySelectorAll('.tier-chip')).toHaveLength(3);
      expect(bar.querySelector('#space-filter-confidence')).not.toBeNull();
      expect(bar.querySelector('#space-filter-semantic')).not.toBeNull();
      expect(bar.querySelector('#space-filter-only-matches')).not.toBeNull();

      // Exactly one global reset action exists.
      expect(document.querySelectorAll('#space-clear-filters')).toHaveLength(1);
      expect(document.querySelectorAll('button.space-clear-filters')).toHaveLength(1);

      // The contextual controls live in the primary row, not a second one.
      const primary = bar.querySelector('.space-filter-primary')!;
      for (const id of [
        'space-filter-tag',
        'space-filter-confidence-field',
        'space-filter-semantic-field',
        'space-filter-only-matches-field',
        'space-clear-filters',
      ]) {
        expect(primary.querySelector(`#${id}`)).not.toBeNull();
      }
      expect(primary.querySelectorAll('.tier-chips')).toHaveLength(1);
      expect(bar.querySelectorAll('.space-filter-controls')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('exposes labelled group semantics and pressed chip state', () => {
    const { document, cleanup } = loadShell();
    try {
      const bar = document.getElementById('space-filter-bar')!;
      expect(bar.getAttribute('role')).toBe('group');
      expect(bar.getAttribute('aria-label')).toBeTruthy();

      const chips = Array.from(bar.querySelectorAll('.tier-chip'));
      for (const chip of chips) {
        expect(chip.getAttribute('aria-pressed')).toBe('true');
        expect(chip.getAttribute('aria-label')).toMatch(/^T[123] — /);
      }
      expect(bar.querySelector('[role="group"][aria-label="Tier filters"]')).not.toBeNull();
      expect(document.querySelector('label[for="space-search"]')?.textContent?.trim()).toBeTruthy();
      expect(document.getElementById('btn-clear-space-search')?.getAttribute('aria-label')).toBe(
        'Clear search'
      );
    } finally {
      cleanup();
    }
  });

  test('global [hidden] guard wins over author display rules', () => {
    // `.filter-field { display: flex }` has the same specificity as the UA
    // `[hidden] { display: none }` rule but comes from the author sheet, so
    // without an explicit `!important` guard the hidden filter fields render
    // and become tabbable. This is a CSS contract assertion.
    const guard = utilitiesCss.match(/\[hidden\]\s*\{([^}]*)\}/);
    expect(guard).not.toBeNull();
    expect(guard?.[1]).toMatch(/display:\s*none\s*!important/);

    // The conflicting author rule is still present; the guard must outrank it.
    expect(shellCss).toMatch(/\.filter-field\s*\{[\s\S]*?display:\s*flex/);
  });

  test('keeps contextual controls hidden until their view is active', () => {
    const { document, cleanup } = loadShell();
    try {
      expect(document.getElementById('space-filter-confidence-field')?.hasAttribute('hidden')).toBe(
        true
      );
      expect(document.getElementById('space-filter-semantic-field')?.hasAttribute('hidden')).toBe(
        true
      );
      expect(
        document.getElementById('space-filter-only-matches-field')?.hasAttribute('hidden')
      ).toBe(true);
      expect(document.getElementById('space-clear-filters')?.hasAttribute('disabled')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('uses compact labels and placeholders instead of visible field labels', () => {
    const { document, cleanup } = loadShell();
    try {
      const search = document.getElementById('space-search') as HTMLInputElement;
      expect(search.getAttribute('placeholder')).toBe('Search memories');
      expect(document.getElementById('space-search-label')?.textContent).toContain(
        'Search in this space'
      );

      const tagLabel = document.querySelector('label[for="space-filter-tag"]');
      expect(tagLabel?.classList.contains('visually-hidden')).toBe(true);

      const tag = document.getElementById('space-filter-tag') as HTMLSelectElement;
      expect(tag.tagName).toBe('SELECT');
      expect(tag.classList.contains('select')).toBe(true);
      expect(tag.classList.contains('filter-control')).toBe(true);
      expect(tag.tagName).not.toBe('INPUT');
      expect(tag.querySelector('option')?.value).toBe('');
      expect(tag.querySelector('option')?.textContent).toBe('All tags');

      const confidenceLabel = document.querySelector('label[for="space-filter-confidence"]');
      expect(confidenceLabel?.classList.contains('visually-hidden')).toBe(true);

      const semantic = document.getElementById('space-filter-semantic') as HTMLInputElement;
      expect(semantic.getAttribute('aria-describedby')).toBe('space-filter-semantic-help');
      const help = document.getElementById('space-filter-semantic-help');
      expect(help?.classList.contains('visually-hidden')).toBe(true);
      const semanticLabel = document.querySelector('label[for="space-filter-semantic"]');
      expect(semanticLabel?.getAttribute('title')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test('orders the primary row search, tag, chips, confidence, embeddings, only matches, clear', () => {
    const order = [
      'id="space-search-form"',
      'id="space-filter-tag"',
      'class="tier-chips"',
      'id="space-filter-confidence-field"',
      'id="space-filter-semantic-field"',
      'id="space-filter-only-matches-field"',
      'id="space-clear-filters"',
    ].map(marker => indexHtml.indexOf(marker));

    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('shares one centered wrapping row without horizontal overflow', () => {
    const primary = rule('.space-filter-primary');
    expect(primary).toMatch(/display:\s*flex/);
    expect(primary).toMatch(/flex-wrap:\s*wrap/);
    expect(primary).toMatch(/align-items:\s*center/);
    expect(primary).toMatch(/min-width:\s*0/);
    expect(primary).toMatch(/max-width:\s*100%/);
    expect(primary).not.toMatch(/align-items:\s*flex-end/);

    const bar = rule('.space-filter-bar');
    expect(bar).toMatch(/flex-wrap:\s*wrap/);
    expect(bar).toMatch(/align-items:\s*center/);
    expect(bar).toMatch(/gap:\s*var\(--space-2\)/);
    expect(bar).toMatch(/max-width:\s*100%/);
    expect(bar).not.toMatch(/flex-direction:\s*column/);
    expect(bar).not.toMatch(/align-items:\s*flex-end/);

    // The old second row is gone.
    expect(shellCss).not.toContain('.space-filter-controls');

    const search = rule('.space-search');
    expect(search).toMatch(/flex:\s*0 1 300px/);
    expect(search).toMatch(/width:\s*auto/);
    expect(search).toMatch(/min-width:\s*0/);

    expect(rule('.filter-tag')).toMatch(/flex:\s*0 1 160px/);
    expect(rule('.tier-chips')).toMatch(/flex:\s*none/);
    expect(rule('.filter-confidence')).toMatch(/flex:\s*0 1 150px/);
    expect(rule('.filter-semantic')).toMatch(/flex-direction:\s*row/);
    expect(rule('.filter-only-matches')).toMatch(/align-self:\s*center/);

    const clear = rule('.space-clear-filters');
    expect(clear).toMatch(/margin-left:\s*auto/);
    expect(clear).toMatch(/height:\s*32px/);

    expect(shellCss).toMatch(/@media\s*\(max-width:\s*700px\)/);
    expect(shellCss).toMatch(/\.space-filter-primary \.space-search\s*\{\s*flex:\s*1 1 100%/);
    expect(shellCss).toMatch(/\.filter-tag,\s*\.filter-confidence\s*\{\s*flex:\s*1 1 160px/);
  });

  test('pairs controls on phone rows so the tag select stays beside the chips', () => {
    // The 700 px rule gives tag and confidence a 160 px basis. On a 288 px
    // content row that forces each onto its own line; the phone rule lowers the
    // bases so tag + chips and confidence + embeddings share rows, keeping the
    // filter bar shorter than the search results floor.
    const phone = mediaBlock('max-width: 480px');

    expect(phone).not.toBe('');
    expect(phone).toMatch(/\.filter-tag\s*\{[^}]*flex:\s*1 1 120px/);
    expect(phone).toMatch(/\.filter-confidence\s*\{[^}]*flex:\s*1 1 150px/);
    expect(phone).not.toMatch(/display:\s*none/);

    // Chips never shrink; the tag select takes the remaining row width.
    expect(rule('.tier-chips')).toMatch(/flex:\s*none/);
    expect(rule('.filter-field .filter-control')).toMatch(/min-width:\s*0/);
  });
});
