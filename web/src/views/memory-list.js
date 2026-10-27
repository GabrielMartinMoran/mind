// @ts-check
/**
 * Pure memory-list renderers for a space.
 *
 * `renderMemoryList` builds the filter bar, the polite status line, the
 * tier-grouped card sections, pagination and the loading/empty/error states.
 * It is a pure DOM builder: it never fetches, reads globals or mutates state.
 * `createMemoryCard` renders one card whose anchor is the primary control and
 * whose tier, name, tags and changed date are non-interactive text.
 */

import { groupMemoriesByTier, tierLabel } from '../domain/memory-model.js';

import { createIcon } from './icon.js';

const TIER_ORDER = /** @type {const} */ ([1, 2, 3]);
const MAX_VISIBLE_TAGS = 3;
const SKELETON_CARDS = 3;

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** @typedef {1 | 2 | 3} Tier */

/**
 * @typedef {Object} MemoryLike
 * @property {string} [id]
 * @property {string} [space_name]
 * @property {string} name
 * @property {number} [tier]
 * @property {boolean} [pinned]
 * @property {string[]} [tags]
 * @property {string} [changed_at]
 */

/**
 * @typedef {Object} MemoryFilters
 * @property {Tier | number | null} [tier]
 * @property {Tier[]} [tiers]
 * @property {string | null} [tag]
 */

/**
 * @typedef {Object} MemoryListState
 * @property {string | { name?: string } | null} [space]
 * @property {MemoryLike[]} [memories]
 * @property {number} [total]
 * @property {boolean} [hasMore]
 * @property {number} [offset]
 * @property {MemoryFilters} [filters]
 * @property {'idle' | 'loading' | 'success' | 'error'} [status]
 * @property {string | null} [error]
 * @property {{ name?: string, id?: string } | null} [currentMemory]
 */

/**
 * @typedef {Object} MemoryListHandlers
 * @property {(name: string, value: string | number | null) => void} [onFilterChange]
 * @property {() => void} [onClearFilters]
 * @property {() => void} [onLoadMore]
 * @property {() => void} [onRetry]
 * @property {() => void} [onCreate]
 * @property {(memory: MemoryLike) => void} [onOpen]
 */

/**
 * @typedef {Object} MemoryCardOptions
 * @property {string} [space]
 * @property {{ name?: string, id?: string } | null} [currentMemory]
 * @property {(memory: MemoryLike) => void} [onOpen]
 */

/**
 * Create an element with an optional class and text content.
 *
 * @param {string} tagName
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} id
 * @param {string} className
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
function createButton(id, className, text) {
  const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  button.type = 'button';
  if (id) button.id = id;
  button.className = className;
  button.textContent = text;
  return button;
}

/**
 * Resolve the space name from either a string or a space-like object.
 *
 * @param {MemoryListState['space']} space
 * @param {MemoryLike} [memory]
 * @returns {string}
 */
function spaceName(space, memory) {
  if (typeof space === 'string' && space) return space;
  if (space && typeof space === 'object' && space.name) return space.name;
  return memory?.space_name ?? '';
}

/**
 * @param {string} space
 * @param {string} name
 * @returns {string}
 */
function memoryHref(space, name) {
  const base = `/spaces/${encodeURIComponent(space)}`;
  return `${base}?memory=${encodeURIComponent(name)}`;
}

/**
 * @param {number} tier
 * @returns {string}
 */
function tierClass(tier) {
  return tier === 1 || tier === 2 || tier === 3 ? `tier-${tier}` : '';
}

/**
 * Format an ISO timestamp as a stable UTC date label.
 *
 * @param {string | undefined} value
 * @returns {string}
 */
function changedLabel(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return DATE_FORMATTER.format(new Date(time));
}

/**
 * @param {MemoryLike} memory
 * @param {MemoryCardOptions} [options]
 * @returns {boolean}
 */
function isCurrent(memory, options) {
  const current = options?.currentMemory ?? null;
  if (!current) return false;
  if (current.name && memory.name === current.name) return true;
  return Boolean(current.id && memory.id && current.id === memory.id);
}

/**
 * Build one memory card. The anchor stretches over the card surface. The tier
 * marker, name, tags and changed date are plain text inside that anchor, so the
 * card has no nested interactive controls.
 *
 * @param {MemoryLike} memory
 * @param {MemoryCardOptions} [options]
 * @returns {HTMLElement}
 */
export function createMemoryCard(memory, options = {}) {
  const card = /** @type {HTMLElement} */ (document.createElement('article'));
  card.className = 'memory-card';
  card.dataset.memoryName = memory.name;

  const space = spaceName(options.space, memory);
  const anchor = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
  anchor.className = 'memory-card-link';
  anchor.href = memoryHref(space, memory.name);

  if (isCurrent(memory, options)) {
    anchor.setAttribute('aria-current', 'true');
    card.classList.add('is-current');
  }

  if (memory.tier === 1 || memory.tier === 2 || memory.tier === 3) {
    const label = tierLabel(memory.tier);
    const marker = element('span', `memory-card-tier ${tierClass(memory.tier)}`, `T${memory.tier}`);
    marker.title = label;
    marker.setAttribute('aria-label', label);
    anchor.appendChild(marker);
  }

  const head = element('span', 'memory-card-head');
  head.appendChild(element('span', 'memory-card-name', memory.name));
  if (memory.pinned) {
    head.appendChild(element('span', 'memory-card-pinned', 'Pinned'));
  }
  anchor.appendChild(head);

  const meta = element('span', 'memory-card-meta');

  const tags = memory.tags ?? [];
  if (tags.length > 0) {
    const tagRow = element('span', 'memory-card-tags');
    for (const tag of tags.slice(0, MAX_VISIBLE_TAGS)) {
      tagRow.appendChild(element('span', 'memory-card-tag', `#${tag}`));
    }
    if (tags.length > MAX_VISIBLE_TAGS) {
      tagRow.appendChild(
        element('span', 'memory-card-tag-more', `+${tags.length - MAX_VISIBLE_TAGS}`)
      );
    }
    meta.appendChild(tagRow);
  }

  const changed = changedLabel(memory.changed_at);
  if (changed) {
    meta.appendChild(element('span', 'memory-card-changed', `Changed ${changed}`));
  }
  anchor.appendChild(meta);

  if (options.onOpen) {
    anchor.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      options.onOpen?.(memory);
    });
  }

  card.appendChild(anchor);

  return card;
}

/**
 * @param {MemoryListState} state
 * @returns {boolean}
 */
function hasActiveFilters(state) {
  const filters = state.filters ?? {};
  const tiers = Array.isArray(filters.tiers) ? filters.tiers : [];
  const hasTier = tiers.length > 0 && tiers.length < 3;
  const hasTag = typeof filters.tag === 'string' && filters.tag.trim() !== '';
  return hasTier || hasTag;
}

/**
 * Polite status text for the current page.
 *
 * @param {MemoryListState} [state]
 * @returns {string}
 */
export function formatMemoryStatus(state = {}) {
  const shown = state.memories?.length ?? 0;
  const total = Number.isFinite(state.total) ? Math.max(0, Number(state.total)) : shown;

  if (state.status === 'loading' && shown === 0) return 'Loading memories…';
  if (total === 0) return '0 memories';
  return `Showing ${shown} of ${total} ${total === 1 ? 'memory' : 'memories'}`;
}

/**
 * @param {MemoryLike[]} memories
 * @param {MemoryListHandlers} handlers
 * @param {MemoryListState} state
 * @returns {HTMLElement}
 */
function renderTierSections(memories, handlers, state) {
  const grouped = groupMemoriesByTier(memories);
  const wrapper = element('div', 'memory-tier-list');

  for (const tier of TIER_ORDER) {
    const tierMemories = /** @type {MemoryLike[]} */ (grouped[tier]);
    const section = element('section', 'memory-tier');
    section.dataset.tier = String(tier);
    section.setAttribute('aria-labelledby', `memory-tier-${tier}-heading`);

    const heading = element('h2', `memory-tier-heading tier-${tier}`);
    heading.id = `memory-tier-${tier}-heading`;
    heading.appendChild(document.createTextNode(tierLabel(tier)));
    // Explicit space so assistive tech reads "T1 — Hot 2", not "Hot2".
    heading.appendChild(document.createTextNode(' '));
    heading.appendChild(element('span', 'memory-tier-count', String(tierMemories.length)));
    section.appendChild(heading);

    if (tierMemories.length === 0) {
      section.appendChild(element('p', 'memory-tier-empty', `No T${tier} memories.`));
    } else {
      const list = /** @type {HTMLUListElement} */ (document.createElement('ul'));
      list.className = 'memory-card-list';
      for (const memory of tierMemories) {
        const item = /** @type {HTMLLIElement} */ (document.createElement('li'));
        item.className = 'memory-card-item';
        item.appendChild(
          createMemoryCard(memory, {
            space: spaceName(state.space),
            currentMemory: state.currentMemory ?? null,
            onOpen: handlers.onOpen,
          })
        );
        list.appendChild(item);
      }
      section.appendChild(list);
    }

    wrapper.appendChild(section);
  }

  return wrapper;
}

/**
 * @returns {HTMLElement}
 */
function renderSkeleton() {
  const list = element('div', 'memory-skeleton-list');
  list.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < SKELETON_CARDS; index += 1) {
    const card = element('div', 'memory-skeleton');
    card.appendChild(element('div', 'skeleton memory-skeleton-title'));
    card.appendChild(element('div', 'skeleton memory-skeleton-meta'));
    card.appendChild(element('div', 'skeleton memory-skeleton-line'));
    list.appendChild(card);
  }

  return list;
}

/**
 * @param {MemoryListHandlers} handlers
 * @returns {HTMLElement}
 */
function renderEmptySpace(handlers) {
  const empty = element('div', 'memory-empty');
  empty.appendChild(
    element(
      'p',
      'memory-empty-message',
      'This space has no memories yet. Add one to start building the atlas.'
    )
  );
  const action = createButton(
    'memory-empty-create',
    'btn btn-sm btn-secondary memory-empty-action',
    'Add a memory'
  );
  action.prepend(createIcon('file-plus'));
  action.addEventListener('click', () => handlers.onCreate?.());
  empty.appendChild(action);
  return empty;
}

/**
 * @returns {HTMLElement}
 */
function renderNoMatch() {
  const empty = element('div', 'memory-empty memory-no-match');
  empty.appendChild(
    element(
      'p',
      'memory-empty-message',
      'No memories match these filters. Clear filters above to see everything in this space.'
    )
  );
  return empty;
}

/**
 * @param {MemoryListState} state
 * @param {MemoryListHandlers} handlers
 * @returns {HTMLElement}
 */
function renderError(state, handlers) {
  const block = element('div', 'memory-error');
  block.setAttribute('role', 'alert');
  block.appendChild(
    element(
      'p',
      'memory-error-message',
      state.error || 'The memories could not be loaded. Try again.'
    )
  );
  const retry = createButton('memory-retry', 'btn btn-sm btn-secondary memory-retry', 'Try again');
  retry.prepend(createIcon('rotate-ccw'));
  retry.addEventListener('click', () => handlers.onRetry?.());
  block.appendChild(retry);
  return block;
}

/**
 * Render the whole memory list for the `#list-view` container.
 *
 * The shell owns the space heading, so this view starts at the filter bar and
 * uses `h2` sections. Handlers own navigation and data loading; this function
 * only builds DOM.
 *
 * @param {MemoryListState} [state]
 * @param {MemoryListHandlers} [handlers]
 * @returns {HTMLElement}
 */
export function renderMemoryList(state = {}, handlers = {}) {
  const memories = state.memories ?? [];
  const isLoading = state.status === 'loading';

  const root = element('section', 'memory-list-view');
  root.setAttribute('aria-busy', String(isLoading));

  const region = element('div', 'memory-list-region');
  region.id = 'memory-list-region';

  const status = element('p', 'memory-status', formatMemoryStatus(state));
  status.id = 'memory-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-busy', String(isLoading));
  region.appendChild(status);

  if (state.status === 'error') {
    region.appendChild(renderError(state, handlers));
    root.appendChild(region);
    return root;
  }

  if (isLoading && memories.length === 0) {
    region.appendChild(renderSkeleton());
    root.appendChild(region);
    return root;
  }

  if (memories.length === 0) {
    region.appendChild(hasActiveFilters(state) ? renderNoMatch() : renderEmptySpace(handlers));
    root.appendChild(region);
    return root;
  }

  region.appendChild(renderTierSections(memories, handlers, state));

  if (state.hasMore) {
    const showMore = createButton(
      'memory-show-more',
      'btn btn-sm btn-secondary memory-show-more',
      'Show more'
    );
    showMore.prepend(createIcon('chevron-down'));
    showMore.disabled = isLoading;
    showMore.addEventListener('click', () => handlers.onLoadMore?.());
    region.appendChild(showMore);
  }

  root.appendChild(region);
  return root;
}
