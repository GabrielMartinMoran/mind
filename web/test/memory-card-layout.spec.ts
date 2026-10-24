import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const memoryListCss = readFileSync(
  join(import.meta.dir, '../styles/components/memory-list.css'),
  'utf8'
);

/** Extract the declaration block for a selector anchored at a line start. */
function ruleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
}

function mediaBlock(source: string, query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@media\\s*${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
}

describe('memory card layout contract', () => {
  test('wide viewports render one compact row with an ellipsized name', () => {
    const card = ruleBlock(memoryListCss, '.memory-card');
    expect(card).toMatch(/flex-direction:\s*row/);
    expect(card).toMatch(/align-items:\s*center/);
    expect(card).toMatch(/min-height:\s*42px/);
    expect(card).toMatch(/padding:\s*var\(--space-2\)\s+var\(--space-3\)/);

    const link = ruleBlock(memoryListCss, '.memory-card-link');
    expect(link).toMatch(/flex-direction:\s*row/);
    expect(link).toMatch(/align-items:\s*center/);
    expect(link).toMatch(/gap:\s*var\(--space-3\)/);
    expect(link).toMatch(/overflow:\s*hidden/);

    const tier = ruleBlock(memoryListCss, '.memory-card-tier');
    expect(tier).toMatch(/display:\s*inline-flex/);
    expect(tier).toMatch(/align-items:\s*center/);
    expect(tier).toMatch(/align-self:\s*center/);
    expect(tier).toMatch(/flex:\s*none/);
    expect(tier).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(tier).toMatch(/line-height:\s*1\.3/);

    const tierDot = ruleBlock(memoryListCss, '.memory-card-tier::before');
    expect(tierDot).toMatch(/width:\s*7px/);
    expect(tierDot).toMatch(/border-radius:\s*50%/);
    expect(tierDot).toMatch(/align-self:\s*center/);
    expect(tierDot).toMatch(/flex:\s*none/);

    const head = ruleBlock(memoryListCss, '.memory-card-head');
    expect(head).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(head).toMatch(/align-self:\s*center/);
    expect(head).toMatch(/min-width:\s*10ch/);
    expect(head).toMatch(/white-space:\s*nowrap/);

    const name = ruleBlock(memoryListCss, '.memory-card-name');
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/white-space:\s*nowrap/);
    // The tier marker and the name share this line box, so their centers meet.
    expect(name).toMatch(/line-height:\s*1\.3/);

    const meta = ruleBlock(memoryListCss, '.memory-card-meta');
    expect(meta).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(meta).toMatch(/align-self:\s*center/);
    expect(meta).toMatch(/align-items:\s*center/);
    expect(meta).toMatch(/min-width:\s*0/);
    expect(meta).toMatch(/justify-content:\s*flex-end/);
    expect(meta).toMatch(/overflow:\s*hidden/);
    expect(meta).toMatch(/white-space:\s*nowrap/);
    expect(meta).not.toMatch(/position:\s*absolute/);
    expect(meta).not.toMatch(/margin-left:\s*auto/);

    const changed = ruleBlock(memoryListCss, '.memory-card-changed');
    expect(changed).toMatch(/flex:\s*none/);
    expect(changed).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(changed).toMatch(/white-space:\s*nowrap/);

    const tags = ruleBlock(memoryListCss, '.memory-card-tags');
    expect(tags).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(tags).toMatch(/min-width:\s*0/);
    expect(tags).toMatch(/overflow:\s*hidden/);
    expect(tags).toMatch(/flex-wrap:\s*nowrap/);
    expect(tags).not.toMatch(/max-width:\s*42%/);
    expect(tags).not.toMatch(/position:\s*absolute/);

    expect(memoryListCss).not.toMatch(/\.memory-card-pin\s*\{/);
  });

  test('tags and name own separate flex regions that grow before truncating', () => {
    // The name region is content-sized; the metadata region absorbs the slack
    // so its tags extend left from the right-aligned date instead of the name
    // claiming the empty space.
    const head = ruleBlock(memoryListCss, '.memory-card-head');
    expect(head).toMatch(/flex:\s*0\s+1\s+auto/);

    const meta = ruleBlock(memoryListCss, '.memory-card-meta');
    expect(meta).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(meta).toMatch(/justify-content:\s*flex-end/);
    expect(meta).toMatch(/min-width:\s*0/);

    const tags = ruleBlock(memoryListCss, '.memory-card-tags');
    expect(tags).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(tags).toMatch(/min-width:\s*0/);
    expect(tags).toMatch(/overflow:\s*hidden/);

    const tagsRule = ruleBlock(memoryListCss, '.memory-card-tags');
    expect(tagsRule).not.toMatch(/max-width:\s*\d+%/);

    const changed = ruleBlock(memoryListCss, '.memory-card-changed');
    expect(changed).toMatch(/flex:\s*none/);
  });

  test('narrow viewports keep tier and name on one row with metadata below', () => {
    const media = mediaBlock(memoryListCss, '(max-width: 860px)');
    expect(media).not.toBe('');

    const link = /\.memory-card-link\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
    expect(link).toMatch(/flex-direction:\s*row/);
    expect(link).toMatch(/flex-wrap:\s*wrap/);
    expect(link).toMatch(/align-items:\s*center/);

    const head = /\.memory-card-head\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
    // A zero basis lets the name share row one with the tier marker instead of
    // taking the full width and pushing itself onto its own row.
    expect(head).toMatch(/flex:\s*1\s+1\s+0/);
    expect(head).toMatch(/min-width:\s*0/);

    const name = /\.memory-card-name\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
    expect(name).toMatch(/white-space:\s*normal/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere/);

    const meta = /\.memory-card-meta\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
    expect(meta).toMatch(/flex:\s*1\s+1\s+100%/);
    expect(meta).toMatch(/margin-left:\s*0/);
    expect(meta).toMatch(/flex-wrap:\s*wrap/);

    const tags = /\.memory-card-tags\s*\{([^}]*)\}/.exec(media)?.[1] ?? '';
    expect(tags).toMatch(/flex-wrap:\s*wrap/);
    expect(tags).toMatch(/max-width:\s*none/);

    expect(media).not.toMatch(/\.memory-card-pin\s*\{/);
  });
});
