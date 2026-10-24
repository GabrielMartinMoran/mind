// @ts-check
/**
 * Space list and home atlas renderers.
 *
 * Pure DOM builders: they accept data as arguments, never fetch, and keep no
 * module-level state. `bindSpaceLinks` is the only piece that attaches events,
 * and it returns a destroy handle so callers stay in control of lifecycle.
 */

/**
 * @typedef {Object} SpaceLike
 * @property {string} name
 * @property {string} [description]
 * @property {number} [memory_count]
 * @property {{ t1?: number, t2?: number, t3?: number }} [tier_counts]
 * @property {string[]} [tags]
 * @property {boolean} [hidden]
 */

/**
 * @typedef {Object} SpaceRef
 * @property {string} [name]
 */

/**
 * @typedef {Object} CardOptions
 * @property {SpaceRef | null} [currentSpace]
 */

/**
 * @typedef {Object} ListOptions
 * @property {SpaceRef | null} [currentSpace]
 * @property {boolean} [includeHidden]
 */

/**
 * @typedef {Object} AtlasOptions
 * @property {SpaceRef | null} [currentSpace]
 */

/**
 * @typedef {Object} SpaceLinkOptions
 * @property {(spaceName: string) => void} [onSelect]
 */

/**
 * @typedef {Object} SpaceLinkBinder
 * @property {() => void} destroy Removes the delegated listener. Safe to call twice.
 */

/**
 * Create a text-bearing element when `text` is provided.
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
 * @param {string} name
 * @returns {string}
 */
function spaceHref(name) {
  return `/spaces/${encodeURIComponent(name)}`;
}

/**
 * @param {number} count
 * @returns {string}
 */
function memoryCountLabel(count) {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read tier counts with zero defaults so legacy payloads still render.
 *
 * @param {SpaceLike} space
 * @returns {{ t1: number, t2: number, t3: number }}
 */
function tierCountsOf(space) {
  const counts = space.tier_counts ?? {};
  return {
    t1: safeCount(counts.t1),
    t2: safeCount(counts.t2),
    t3: safeCount(counts.t3),
  };
}

/**
 * Tier keys in display order, shared by the spectrum and the chip row.
 */
const TIER_KEYS = /** @type {const} */ (['t1', 't2', 't3']);

/**
 * Build the proportional T1/T2/T3 bar. It is decorative, so the counts beside
 * it carry the accessible information.
 *
 * @param {{ t1: number, t2: number, t3: number }} counts
 * @returns {HTMLElement}
 */
function createTierSpectrum(counts) {
  const spectrum = element('span', 'space-tier-spectrum');
  spectrum.setAttribute('aria-hidden', 'true');
  for (const tier of TIER_KEYS) {
    const segment = element('span', `space-tier-segment ${tier}`);
    segment.style.flexGrow = String(counts[tier]);
    spectrum.appendChild(segment);
  }
  return spectrum;
}

/**
 * Build one passive chip: a quiet label, a space, then the emphasized count.
 * The explicit text node keeps `textContent` as `T1 1` for assistive tech.
 *
 * @param {'t1' | 't2' | 't3'} tier
 * @param {number} count
 * @returns {HTMLElement}
 */
function createTierChip(tier, count) {
  const chip = element('span', `space-tier-count ${tier}${count === 0 ? ' is-zero' : ''}`);
  chip.appendChild(element('span', 'space-tier-label', tier.toUpperCase()));
  chip.appendChild(document.createTextNode(' '));
  chip.appendChild(element('span', 'space-tier-value', String(count)));
  return chip;
}

/**
 * Build the T1/T2/T3 spectrum and counts, or a neutral empty state when the
 * space has no memories.
 *
 * @param {SpaceLike} space
 * @returns {HTMLElement}
 */
function createTierBlock(space) {
  const block = element('span', 'space-tier');
  const counts = tierCountsOf(space);

  if ((space.memory_count ?? 0) === 0) {
    block.appendChild(element('span', 'space-tier-empty', 'No memories yet'));
    return block;
  }

  block.appendChild(createTierSpectrum(counts));

  const countRow = element('span', 'space-tier-counts');
  for (const tier of TIER_KEYS) {
    countRow.appendChild(createTierChip(tier, counts[tier]));
  }
  block.appendChild(countRow);

  return block;
}

/**
 * Build the anchor card used by the home atlas.
 *
 * The card is a single anchor. Tags and the hidden marker are plain text, so
 * there are no nested interactive elements inside the link.
 *
 * @param {SpaceLike} space
 * @param {CardOptions} [options]
 * @returns {HTMLAnchorElement}
 */
export function createSpaceCard(space, options = {}) {
  const currentSpace = options.currentSpace ?? null;
  const card = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
  card.className = 'space-card';
  card.href = spaceHref(space.name);
  card.dataset.spaceLink = '';
  card.dataset.spaceName = space.name;

  if (currentSpace && currentSpace.name === space.name) {
    card.setAttribute('aria-current', 'page');
  }

  const header = element('span', 'space-card-header');
  header.appendChild(element('span', 'space-card-name', space.name));
  if (space.hidden) {
    header.appendChild(element('span', 'space-card-badge', 'Hidden'));
  }
  card.appendChild(header);

  card.appendChild(
    element('span', 'space-card-description', space.description || 'No description')
  );

  card.appendChild(createTierBlock(space));

  const meta = element('span', 'space-card-meta');
  meta.appendChild(element('span', 'space-card-count', memoryCountLabel(space.memory_count ?? 0)));

  const tags = space.tags ?? [];
  const visibleTags = tags.slice(0, 3);
  if (visibleTags.length > 0) {
    const tagRow = element('span', 'space-card-tags');
    tagRow.title = tags.map(tag => `#${tag}`).join(' ');
    for (const tag of visibleTags) {
      tagRow.appendChild(element('span', 'space-card-tag', `#${tag}`));
    }
    if (tags.length > visibleTags.length) {
      tagRow.appendChild(
        element('span', 'space-card-tag-more', `+${tags.length - visibleTags.length}`)
      );
    }
    meta.appendChild(tagRow);
  }
  card.appendChild(meta);

  return card;
}

/**
 * Render the sidebar list items. Hidden spaces are filtered out unless
 * `includeHidden` is true. The active space carries `aria-current="page"`.
 *
 * @param {readonly SpaceLike[]} spaces
 * @param {ListOptions} [options]
 * @returns {HTMLLIElement[]}
 */
export function renderSpaceList(spaces, options = {}) {
  const currentSpace = options.currentSpace ?? null;
  const includeHidden = options.includeHidden === true;
  const visible = (spaces ?? []).filter(space => includeHidden || !space.hidden);

  return visible.map(space => {
    const item = /** @type {HTMLLIElement} */ (document.createElement('li'));
    item.className = 'space-list-item';

    const link = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
    link.className = 'nav-item space-link' + (space.hidden ? ' space-hidden' : '');
    link.href = spaceHref(space.name);
    link.dataset.spaceLink = '';
    link.dataset.spaceName = space.name;

    if (currentSpace && currentSpace.name === space.name) {
      link.setAttribute('aria-current', 'page');
      link.classList.add('is-active');
    }

    link.appendChild(element('span', 'nav-item-name', space.name));
    if (space.hidden) {
      link.appendChild(element('span', 'space-hidden-badge', 'Hidden'));
    }
    link.appendChild(element('span', 'nav-item-count', String(space.memory_count ?? 0)));

    item.appendChild(link);
    return item;
  });
}

/**
 * Build the All spaces grid items for the given spaces. The caller owns the
 * stable `<ul>` and the search control, so filtering only replaces these rows.
 *
 * @param {readonly SpaceLike[]} spaces
 * @param {AtlasOptions} [options]
 * @returns {HTMLLIElement[]}
 */
export function renderHomeSpaces(spaces, options = {}) {
  return (spaces ?? []).map(space => {
    const item = /** @type {HTMLLIElement} */ (document.createElement('li'));
    item.className = 'home-atlas-item';
    item.appendChild(createSpaceCard(space, { currentSpace: options.currentSpace ?? null }));
    return item;
  });
}

/**
 * Delegate plain primary clicks on `a[data-space-link]` to `onSelect`.
 *
 * Modifier clicks and non-primary buttons fall through so the browser can open
 * the href in a new tab or window. The listener is delegated, so it keeps
 * working after the list re-renders.
 *
 * @param {HTMLElement | Document} root
 * @param {SpaceLinkOptions} [options]
 * @returns {SpaceLinkBinder}
 */
export function bindSpaceLinks(root, options = {}) {
  const onSelect = options.onSelect;
  let bound = true;

  /** @param {Event} rawEvent */
  function onClick(rawEvent) {
    if (!bound) return;
    const event = /** @type {MouseEvent} */ (rawEvent);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = /** @type {Element | null} */ (event.target);
    if (!target || typeof target.closest !== 'function') return;

    const anchor = target.closest('a[data-space-link]');
    if (!anchor || anchor.tagName !== 'A') return;
    if (typeof root.contains === 'function' && !root.contains(anchor)) return;

    const spaceName = /** @type {HTMLElement} */ (anchor).dataset.spaceName;
    if (!spaceName) return;

    event.preventDefault();
    if (onSelect) onSelect(spaceName);
  }

  root.addEventListener('click', onClick);

  return {
    destroy() {
      if (!bound) return;
      bound = false;
      root.removeEventListener('click', onClick);
    },
  };
}
