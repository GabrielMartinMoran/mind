import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const stylesDir = join(import.meta.dir, '../styles');

function readStyle(name: string): string {
  return readFileSync(join(stylesDir, name), 'utf8');
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

function mediaBlock(css: string, query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

const searchCss = readStyle('components/search.css');
const shellCss = readStyle('components/shell.css');

/**
 * The in-space search surface is a bounded flex child of #space-detail. It must
 * not grow with its results: #space-detail is fixed to the viewport, so an
 * unbounded child clips later result cards with no scroll owner.
 */
describe('space search layout contract', () => {
  test('the search view is a bounded flex child', () => {
    const view = rule(searchCss, '#space-search-view');

    expect(view).toMatch(/display:\s*flex/);
    expect(view).toMatch(/flex:\s*1/);
    expect(view).toMatch(/flex-direction:\s*column/);
    expect(view).toMatch(/min-width:\s*0/);
    expect(view).toMatch(/min-height:\s*0/);
    expect(view).toMatch(/overflow:\s*hidden/);
  });

  test('the results region fills the view without overflowing it', () => {
    const region = rule(searchCss, '#space-search-view .search-results-region');

    expect(region).toMatch(/flex:\s*1/);
    expect(region).toMatch(/min-width:\s*0/);
    expect(region).toMatch(/min-height:\s*0/);
  });

  test('the result body owns the vertical scroll', () => {
    const body = rule(searchCss, '#space-search-view .search-results-body');

    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });

  test('the status line stays outside the scroller and does not shrink away', () => {
    const status = rule(searchCss, '#space-search-view .search-status');

    expect(status).toMatch(/flex-shrink:\s*0/);
  });

  test('the space header stays a non-shrinking fixed block', () => {
    const header = rule(shellCss, '.panel-header');

    expect(header).toMatch(/flex-shrink:\s*0/);
  });

  test('keeps the page fixed instead of adding a page-scroll workaround', () => {
    // The fix must live in the search surface, not by making the shell or the
    // space detail scroll. Those stay fixed-height/overflow-hidden in layout.css.
    expect(searchCss).not.toMatch(/(?:^|\n)\s*body\s*\{/);
    expect(searchCss).not.toMatch(/(?:^|\n)\s*#space-detail\s*\{/);
    expect(searchCss).not.toMatch(/position:\s*sticky/);
    expect(searchCss).not.toMatch(/100vh|100dvh/);
  });

  test('identity and action rows stay single-line without adding header height', () => {
    // New memory lives beside the title, so the action row keeps only the view
    // toggle and delete. Both rows must stay one line to protect the results
    // floor at 320x700.
    const identity = rule(shellCss, '.space-identity');
    expect(identity).toMatch(/display:\s*flex/);
    expect(identity).toMatch(/flex-wrap:\s*nowrap/);
    expect(identity).toMatch(/align-items:\s*center/);

    const actions = rule(shellCss, '#space-detail .panel-actions');
    expect(actions).toMatch(/width:\s*100%/);
    expect(actions).toMatch(/gap:\s*var\(--space-2\)/);
  });

  test('compacts phone filter rows to preserve a results floor without hiding controls', () => {
    // At 320x700 the 160 px tag field and 140 px tier chips cannot share a row,
    // so two extra wrapped rows left the scrolling body at 111 px. Pairing the
    // tag select with the chips and confidence with embeddings restores at
    // least 120 px while every filter stays visible and tappable.
    const phone = mediaBlock(shellCss, 'max-width: 480px');

    expect(phone).not.toBe('');
    expect(phone).toMatch(/\.filter-tag\s*\{[^}]*flex:\s*1 1 120px/);
    expect(phone).toMatch(/\.filter-confidence\s*\{[^}]*flex:\s*1 1 150px/);
    expect(phone).not.toMatch(/display:\s*none/);
    expect(phone).not.toMatch(/visibility:\s*hidden/);

    // The results floor stays owned by the bounded body under the fixed header.
    const body = rule(searchCss, '#space-search-view .search-results-body');
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(rule(shellCss, '.panel-header')).toMatch(/flex-shrink:\s*0/);
  });
});
