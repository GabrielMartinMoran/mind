import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderLogsView } from '../src/views/logs-view.js';

import { installDom, type DomHarness } from './helpers/dom';

const logsCss = readFileSync(join(import.meta.dir, '../styles/components/logs.css'), 'utf8');
const indexHtml = readFileSync(join(import.meta.dir, '../public/index.html'), 'utf8');

/** Extract the first declaration block for an exact selector. */
function cssRule(selector: string): string {
  return ruleFrom(logsCss, selector);
}

/** Extract the first declaration block for an exact selector inside `source`. */
function ruleFrom(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

/** Extract the inner text of the first `@media (...) { … }` block matching `query`. */
function mediaBlock(query: string): string {
  const start = logsCss.indexOf(query);
  if (start === -1) return '';
  const open = logsCss.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < logsCss.length; index += 1) {
    if (logsCss[index] === '{') depth += 1;
    if (logsCss[index] === '}') {
      depth -= 1;
      if (depth === 0) return logsCss.slice(open + 1, index);
    }
  }
  return '';
}

interface LogFixture {
  id: number;
  source: string;
  operation: string;
  level: string;
  input_data?: string | null;
  output_data?: string | null;
  error_message?: string | null;
  caller_info?: string | null;
  duration_ms?: number | null;
  timestamp: string;
}

function log(overrides: Partial<LogFixture> = {}): LogFixture {
  return {
    id: 1,
    source: 'api',
    operation: 'search_memories',
    level: 'info',
    input_data: '{"q":"auth"}',
    output_data: '{"count":2}',
    error_message: null,
    caller_info: null,
    duration_ms: 12,
    timestamp: '2026-10-20 10:00:00',
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    logs: [],
    total: 0,
    limit: 25,
    offset: 0,
    filters: { source: '', operation: '', level: '', search: '', from: '', to: '' },
    live: false,
    status: 'success',
    error: null,
    expandedId: null,
    visible: true,
    ...overrides,
  };
}

function render(
  dom: DomHarness,
  viewState: Record<string, unknown>,
  handlers: Record<string, unknown> = {}
): HTMLElement {
  const view = renderLogsView(viewState as never, handlers as never) as HTMLElement;
  dom.document.body.appendChild(view);
  return view;
}

function click(dom: DomHarness, target: Element): any {
  const event = new dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  } as never);
  target.dispatchEvent(event as never);
  return event;
}

function change(dom: DomHarness, target: Element): void {
  target.dispatchEvent(new dom.window.Event('change', { bubbles: true }) as never);
}

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

/** The local sprite href of the first icon found inside `root`. */
function iconHref(root: ParentNode | null): string | null {
  return root?.querySelector('svg use')?.getAttribute('href') ?? null;
}

describe('logs view structure and filters', () => {
  test('renders a labelled region with no second h1', () => {
    const dom = installDom();
    try {
      const view = render(dom, state());

      expect(view.tagName).toBe('SECTION');
      expect(view.getAttribute('aria-labelledby')).toBe('logs-heading');
      expect(view.querySelectorAll('h1')).toHaveLength(0);
      expect(query<HTMLElement>(view, '.logs-filters')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders visible labels for every filter', () => {
    const dom = installDom();
    try {
      render(dom, state());

      for (const [id, label] of [
        ['log-filter-source', 'Source'],
        ['log-filter-operation', 'Operation'],
        ['log-filter-level', 'Level'],
        ['log-filter-search', 'Search'],
        ['log-filter-from', 'From'],
        ['log-filter-to', 'To'],
      ] as const) {
        const node = dom.document.querySelector(`label[for="${id}"]`);
        expect(node?.textContent).toBe(label);
      }
    } finally {
      dom.cleanup();
    }
  });

  test('reports filter changes without owning state', () => {
    const dom = installDom();
    try {
      const calls: Array<[string, unknown]> = [];
      const view = render(dom, state(), {
        onFilterChange: (name: string, value: unknown) => calls.push([name, value]),
      });

      const source = query<HTMLSelectElement>(view, '#log-filter-source')!;
      source.value = 'cli';
      change(dom, source);

      const operation = query<HTMLInputElement>(view, '#log-filter-operation')!;
      operation.value = ' add_memory ';
      change(dom, operation);

      const level = query<HTMLSelectElement>(view, '#log-filter-level')!;
      level.value = 'error';
      change(dom, level);

      const search = query<HTMLInputElement>(view, '#log-filter-search')!;
      search.value = '  memory  ';
      change(dom, search);

      const from = query<HTMLInputElement>(view, '#log-filter-from')!;
      from.value = '2026-10-01';
      change(dom, from);

      const to = query<HTMLInputElement>(view, '#log-filter-to')!;
      to.value = '2026-10-31';
      change(dom, to);

      expect(calls).toEqual([
        ['source', 'cli'],
        ['operation', 'add_memory'],
        ['level', 'error'],
        ['search', 'memory'],
        ['from', '2026-10-01'],
        ['to', '2026-10-31'],
      ]);
    } finally {
      dom.cleanup();
    }
  });

  test('clears filters through the handler', () => {
    const dom = installDom();
    try {
      let cleared = 0;
      const view = render(dom, state(), { onClearFilters: () => (cleared += 1) });
      click(dom, query<HTMLElement>(view, '.logs-clear-filters')!);
      expect(cleared).toBe(1);
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view rows and details', () => {
  test('makes the horizontal table scroller reachable and named', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 1 }));
      const wrapper = query<HTMLElement>(view, '.logs-table-wrap')!;

      expect(wrapper.tabIndex).toBe(0);
      expect(wrapper.getAttribute('role')).toBe('region');
      expect(wrapper.getAttribute('aria-label')?.toLowerCase()).toContain('scroll');
    } finally {
      dom.cleanup();
    }
  });

  test('scrolls the table internally under a sticky header instead of growing the page', () => {
    const wrap = cssRule('.logs-table-wrap');
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(wrap).toMatch(/max-height:\s*100%/);
    expect(wrap).toMatch(/flex:\s*1 1 auto/);
    expect(wrap).toMatch(/min-height:\s*0/);

    const head = cssRule('.logs-table thead th');
    expect(head).toMatch(/position:\s*sticky/);
    expect(head).toMatch(/top:\s*0/);

    // The page and region own a bounded height so the table gets the remainder.
    const page = cssRule('#logs-page');
    expect(page).toMatch(/display:\s*flex/);
    expect(page).toMatch(/flex:\s*1/);
    expect(page).toMatch(/min-height:\s*0/);
    expect(page).toMatch(/overflow:\s*hidden/);

    const region = cssRule('.logs-region');
    expect(region).toMatch(/flex:\s*1/);
    expect(region).toMatch(/min-height:\s*0/);
  });

  test('P1c keeps the logs body a bounded flex column that owns the table wrapper scroll', () => {
    const body = cssRule('.logs-body');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);

    const wrap = cssRule('.logs-table-wrap');
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(wrap).toMatch(/flex:\s*1 1 auto/);
    expect(wrap).toMatch(/min-height:\s*0/);

    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 1 }));
      const bodyNode = query<HTMLElement>(view, '.logs-body');
      const wrapNode = query<HTMLElement>(view, '.logs-body > .logs-table-wrap');

      expect(bodyNode).not.toBeNull();
      expect(bodyNode?.parentElement?.classList.contains('logs-region')).toBe(true);
      expect(wrapNode).not.toBeNull();
      expect(wrapNode?.querySelector('table.logs-table')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('keeps Clear logs on the title row, right aligned', () => {
    const page = indexHtml.slice(indexHtml.indexOf('id="logs-page"'));
    const headerEnd = page.indexOf('</header>');
    const header = page.slice(0, headerEnd);

    expect(header).toContain('id="logs-heading"');
    expect(header).toContain('id="btn-clear-logs"');
    expect(header.indexOf('id="logs-heading"')).toBeLessThan(header.indexOf('id="btn-clear-logs"'));

    const headerRule = cssRule('#logs-page > .logs-page-header');
    expect(headerRule).toMatch(/flex-direction:\s*row/);
    expect(headerRule).toMatch(/align-items:\s*center/);

    expect(cssRule('#logs-page .panel-actions')).toMatch(/margin-left:\s*auto/);
  });

  test('renders one table row per log with time, source, operation, level, duration and summary', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({ id: 1, source: 'cli', operation: 'add_memory', level: 'info', duration_ms: 7 }),
            log({
              id: 2,
              source: 'api',
              operation: 'search_memories',
              level: 'error',
              duration_ms: null,
              error_message: 'boom',
            }),
          ],
          total: 2,
        })
      );

      const rows = view.querySelectorAll('tbody tr.logs-row');
      expect(rows).toHaveLength(2);
      // The visible text stays human readable, the machine datetime is ISO.
      const time = query<HTMLTimeElement>(rows[0], 'time.logs-time')!;
      expect(time.getAttribute('datetime')).toBe('2026-10-20T10:00:00Z');
      expect(rows[0].textContent).toContain('2026-10-20 10:00:00');
      expect(rows[0].textContent).toContain('cli');
      expect(rows[0].textContent).toContain('add_memory');
      expect(rows[0].textContent).toContain('info');
      expect(rows[0].textContent).toContain('7ms');
      expect(rows[1].textContent).toContain('error');
      expect(rows[1].textContent).toContain('—');
      expect(rows[1].textContent).toContain('boom');
    } finally {
      dom.cleanup();
    }
  });

  test('toggles details through a real button', () => {
    const dom = installDom();
    try {
      const toggles: unknown[] = [];
      const view = render(dom, state({ logs: [log({ id: 42 })], total: 1 }), {
        onToggleDetails: (id: unknown) => toggles.push(id),
      });

      const button = query<HTMLButtonElement>(view, '.logs-details-toggle')!;
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      click(dom, button);
      expect(toggles).toEqual([42]);
    } finally {
      dom.cleanup();
    }
  });

  test('renders expanded input, output and error details as text', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({
              id: 7,
              input_data: '{"q":"auth"}',
              output_data: '{"count":2}',
              error_message: 'kaboom',
            }),
          ],
          total: 1,
          expandedId: 7,
        })
      );

      const details = query<HTMLElement>(view, '#log-details-7');
      expect(details).not.toBeNull();
      expect(details?.textContent).toContain('Input');
      expect(details?.textContent).toContain('"q": "auth"');
      expect(details?.textContent).toContain('Output');
      expect(details?.textContent).toContain('"count": 2');
      expect(details?.textContent).toContain('kaboom');

      const button = query<HTMLButtonElement>(view, '.logs-details-toggle')!;
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.getAttribute('aria-controls')).toBe('log-details-7');
    } finally {
      dom.cleanup();
    }
  });

  test('never injects user content as markup', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({
              id: 9,
              operation: '<script>alert(1)</script>',
              input_data: '{"html":"<img src=x onerror=alert(1)>"}',
              error_message: '<b>not bold</b>',
            }),
          ],
          total: 1,
          expandedId: 9,
        })
      );

      expect(view.querySelector('script')).toBeNull();
      expect(view.querySelector('img')).toBeNull();
      expect(view.querySelector('b')).toBeNull();

      const text = view.textContent ?? '';
      expect(text).toContain('<script>alert(1)</script>');
      expect(text).toContain('<img src=x onerror=alert(1)>');
      expect(text).toContain('<b>not bold</b>');
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view agent column', () => {
  test('renders the Agent header between Source and Operation', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 1 }));
      const headers = Array.from(view.querySelectorAll('thead th')).map(
        header => header.textContent
      );

      expect(headers).toEqual([
        'Time',
        'Source',
        'Agent',
        'Operation',
        'Level',
        'Duration',
        'Summary',
        'Details',
      ]);
      expect(headers.indexOf('Agent')).toBe(headers.indexOf('Source') + 1);
    } finally {
      dom.cleanup();
    }
  });

  test('shows a compact known agent label and keeps the raw value in the title', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({
              id: 1,
              source: 'mcp',
              operation: 'memory_add',
              caller_info: JSON.stringify({
                agent: 'claude-code',
                agentSource: 'env',
                transport: 'stdio',
              }),
            }),
          ],
          total: 1,
        })
      );

      const cell = query<HTMLElement>(view, 'tbody tr.logs-row td:nth-child(3)')!;
      expect(cell.textContent).toBe('Claude Code');
      expect(query<HTMLElement>(cell, '.logs-agent')?.getAttribute('title')).toBe('claude-code');
    } finally {
      dom.cleanup();
    }
  });

  test('shows an unknown canonical agent value without leaking the rest of caller_info', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({
              id: 1,
              source: 'mcp',
              caller_info: '{"agent":"future-client","agentSource":"client","mcpSession":"s3cr3t"}',
            }),
          ],
          total: 1,
        })
      );

      const cell = query<HTMLElement>(view, 'tbody tr.logs-row td:nth-child(3)')!;
      expect(cell.textContent).toBe('future-client');
      expect(cell.textContent).not.toContain('s3cr3t');
      expect(query<HTMLElement>(cell, '.logs-agent')?.getAttribute('title')).toBe('future-client');
    } finally {
      dom.cleanup();
    }
  });

  test('shows an accessible em dash when a CLI or API row has no agent', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({ logs: [log({ source: 'cli', caller_info: null })], total: 1 })
      );

      const none = query<HTMLElement>(view, 'tbody tr.logs-row .logs-agent-none')!;
      expect(none.textContent).toContain('—');
      expect(query<HTMLElement>(none, '.visually-hidden')?.textContent).toBe('No agent recorded');
      expect(none.getAttribute('title')).toBe('No agent recorded');
    } finally {
      dom.cleanup();
    }
  });

  test('never injects malformed or hostile caller_info as markup', () => {
    const dom = installDom();
    try {
      const view = render(
        dom,
        state({
          logs: [
            log({
              id: 1,
              caller_info: '{"agent":"<img src=x onerror=alert(1)>"}',
            }),
          ],
          total: 1,
        })
      );

      expect(view.querySelector('img')).toBeNull();
      expect(view.querySelector('script')).toBeNull();
      const cell = query<HTMLElement>(view, 'tbody tr.logs-row td:nth-child(3)')!;
      expect(cell.textContent).toContain('<img src=x onerror=alert(1)>');
    } finally {
      dom.cleanup();
    }
  });

  test('keeps the actions column reachable at narrow and wide widths', () => {
    // The table scrolls inside its wrapper, so the last (actions) column is
    // reachable at 320px instead of being clipped by the page, and the same
    // rule lets the table use the full width at 1280px without page overflow.
    const wrap = cssRule('.logs-table-wrap');
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(wrap).toMatch(/min-width:\s*0/);

    const page = cssRule('#logs-page');
    expect(page).toMatch(/overflow:\s*hidden/);
    expect(page).toMatch(/min-width:\s*0/);

    const table = cssRule('.logs-table');
    expect(table).toMatch(/min-width:\s*\d+px/);

    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 1 }));
      const headers = view.querySelectorAll('thead th');
      expect(headers[headers.length - 1].textContent).toBe('Details');

      const cells = view.querySelectorAll('tbody tr.logs-row td');
      expect(cells[cells.length - 1].classList.contains('logs-cell-actions')).toBe(true);
      expect(query<HTMLElement>(cells[cells.length - 1], '.logs-details-toggle')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view command icons', () => {
  test('clear, retry and details commands use decorative local sprite icons', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 120, limit: 25, offset: 0 }));

      const clear = query<HTMLButtonElement>(view, '#logs-clear-filters')!;
      const details = query<HTMLButtonElement>(view, '.logs-details-toggle')!;

      expect(iconHref(clear)).toBe('/assets/icons.svg#icon-filter-x');
      expect(iconHref(details)).toBe('/assets/icons.svg#icon-chevron-right');
      expect(details.textContent).toContain('Details');

      for (const button of [clear, details]) {
        const svg = button.querySelector('svg')!;
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('focusable')).toBe('false');
      }

      const expanded = render(
        dom,
        state({ logs: [log()], total: 120, limit: 25, offset: 0, expandedId: 1 })
      );
      expect(iconHref(query<HTMLElement>(expanded, '.logs-details-toggle'))).toBe(
        '/assets/icons.svg#icon-chevron-down'
      );
    } finally {
      dom.cleanup();
    }
  });

  test('pagination arrows are icon commands while page numbers stay icon-free', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 120, limit: 25, offset: 50 }));

      const prev = query<HTMLButtonElement>(view, '#logs-page-prev')!;
      const next = query<HTMLButtonElement>(view, '#logs-page-next')!;

      expect(iconHref(prev)).toBe('/assets/icons.svg#icon-chevron-left');
      expect(iconHref(next)).toBe('/assets/icons.svg#icon-chevron-right');
      expect(prev.textContent).toContain('Previous');
      expect(next.textContent).toContain('Next');

      const pageButton = query<HTMLButtonElement>(view, '#logs-page-3')!;
      expect(pageButton.querySelector('svg')).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('the error retry action uses the shared retry icon', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ status: 'error', error: 'Network down' }));
      const retry = query<HTMLButtonElement>(view, '.logs-retry')!;

      expect(iconHref(retry)).toBe('/assets/icons.svg#icon-rotate-ccw');
      expect(retry.textContent).toContain('Try again');
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view pagination', () => {
  test('shows the range and disables previous on the first page', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 120, limit: 25, offset: 0 }));

      expect(query<HTMLElement>(view, '#logs-status')?.textContent).toBe(
        'Showing 1–25 of 120 logs'
      );
      expect(query<HTMLButtonElement>(view, '#logs-page-prev')?.disabled).toBe(true);
      expect(query<HTMLButtonElement>(view, '#logs-page-next')?.disabled).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test('reports next and specific page navigation', () => {
    const dom = installDom();
    try {
      const pages: number[] = [];
      const view = render(dom, state({ logs: [log()], total: 120, limit: 25, offset: 0 }), {
        onPageChange: (page: number) => pages.push(page),
      });

      click(dom, query<HTMLElement>(view, '#logs-page-next')!);
      click(dom, query<HTMLElement>(view, '#logs-page-3')!);
      expect(pages).toEqual([2, 3]);
    } finally {
      dom.cleanup();
    }
  });

  test('disables next on the last page and marks the current page', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 120, limit: 25, offset: 100 }));

      expect(query<HTMLElement>(view, '#logs-status')?.textContent).toBe(
        'Showing 101–120 of 120 logs'
      );
      expect(query<HTMLButtonElement>(view, '#logs-page-next')?.disabled).toBe(true);
      expect(query<HTMLElement>(view, '#logs-page-5')?.getAttribute('aria-current')).toBe('page');
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view live mode', () => {
  test('reflects the live checkbox and reports changes', () => {
    const dom = installDom();
    try {
      const changes: boolean[] = [];
      const view = render(dom, state({ live: true }), {
        onLiveChange: (enabled: boolean) => changes.push(enabled),
      });

      const toggle = query<HTMLInputElement>(view, '#logs-live-toggle')!;
      expect(toggle.checked).toBe(true);
      toggle.checked = false;
      change(dom, toggle);
      expect(changes).toEqual([false]);
    } finally {
      dom.cleanup();
    }
  });

  test('shows a pause indicator while the tab is hidden', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ live: true, visible: false }));
      expect(query<HTMLElement>(view, '.logs-live-state')?.textContent).toContain(
        'Paused while tab is hidden'
      );
    } finally {
      dom.cleanup();
    }
  });

  test('shows the last updated time when live', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ live: true, logs: [log()], total: 1 }));
      expect(query<HTMLElement>(view, '.logs-live-state')?.textContent).toContain(
        '2026-10-20 10:00:00'
      );
    } finally {
      dom.cleanup();
    }
  });
});

describe('logs view async and edge states', () => {
  test('renders a skeleton and marks the region busy while loading', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ status: 'loading' }));

      expect(view.getAttribute('aria-busy')).toBe('true');
      expect(query<HTMLElement>(view, '.logs-skeleton')).not.toBeNull();
      expect(query<HTMLElement>(view, '#logs-status')?.textContent).toBe('Loading logs…');
    } finally {
      dom.cleanup();
    }
  });

  test('distinguishes no logs from no matches', () => {
    const dom = installDom();
    try {
      const empty = render(dom, state());
      expect(empty.textContent).toContain('No logs recorded yet.');

      const filtered = render(
        dom,
        state({
          filters: { source: 'cli', operation: '', level: '', search: '', from: '', to: '' },
        })
      );
      expect(filtered.textContent).toContain('No logs match these filters.');
      expect(query<HTMLElement>(filtered, '.logs-clear-filters')).not.toBeNull();
    } finally {
      dom.cleanup();
    }
  });

  test('renders an error alert with retry', () => {
    const dom = installDom();
    try {
      let retried = 0;
      const view = render(dom, state({ status: 'error', error: 'Network down' }), {
        onRetry: () => (retried += 1),
      });

      const alert = query<HTMLElement>(view, '[role="alert"]')!;
      expect(alert.textContent).toContain('Network down');
      click(dom, query<HTMLElement>(alert, '.logs-retry')!);
      expect(retried).toBe(1);
    } finally {
      dom.cleanup();
    }
  });

  test('caps the rendered rows and shows a notice', () => {
    const dom = installDom();
    try {
      const logs = Array.from({ length: 600 }, (_, index) =>
        log({ id: 600 - index, timestamp: '2026-10-20 10:00:00' })
      );
      const view = render(dom, state({ logs, total: 600 }));

      expect(view.querySelectorAll('tbody tr.logs-row')).toHaveLength(500);
      const notice = query<HTMLElement>(view, '.logs-cap-notice');
      expect(notice?.textContent).toContain('newest 500');
      expect(notice?.textContent).toContain('100 older');
    } finally {
      dom.cleanup();
    }
  });

  test('shows a cap notice for rows the app already dropped', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 600, dropped: 100 }));
      const notice = query<HTMLElement>(view, '.logs-cap-notice');
      expect(notice?.textContent).toContain('newest 500');
      expect(notice?.textContent).toContain('100 older');
    } finally {
      dom.cleanup();
    }
  });

  test('reserves usable table height at narrow widths and scrolls the page instead of clipping', () => {
    // Regression guard: at 320px the stacked filters used to consume the whole
    // fixed-height logs budget, collapsing the wrapper to 0–21px and clipping
    // every row and Details action. The narrow layout must instead scroll the
    // logs page and keep the table wrapper at least 180px tall with its own
    // scroll. This is a CSS contract check; geometry is verified in Playwright.
    const narrow = mediaBlock('@media (max-width: 599px)');
    expect(narrow).not.toBe('');

    const page = ruleFrom(narrow, '#logs-page');
    expect(page).toMatch(/overflow-y:\s*auto/);
    expect(page).toMatch(/overflow-x:\s*hidden/);

    // The flex chain must stop clipping its children so the page can scroll.
    expect(ruleFrom(narrow, '#logs-view')).toMatch(/overflow:\s*visible/);
    expect(ruleFrom(narrow, '.logs-region')).toMatch(/overflow:\s*visible/);
    expect(ruleFrom(narrow, '.logs-body')).toMatch(/overflow:\s*visible/);

    const wrap = ruleFrom(narrow, '.logs-table-wrap');
    const minHeight = wrap.match(/min-height:\s*(\d+)px/);
    expect(minHeight).not.toBeNull();
    expect(Number(minHeight?.[1])).toBeGreaterThanOrEqual(180);
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(wrap).toMatch(/max-height:\s*\d+vh/);
  });

  test('exposes a polite status region and busy state', () => {
    const dom = installDom();
    try {
      const view = render(dom, state({ logs: [log()], total: 1 }));
      const status = query<HTMLElement>(view, '#logs-status')!;

      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.getAttribute('aria-busy')).toBe('false');
      expect(view.getAttribute('aria-busy')).toBe('false');
    } finally {
      dom.cleanup();
    }
  });
});
