// @ts-check
/**
 * Pure tag-option model for the shared space filter bar.
 *
 * The server returns the distinct memory tags of one space. The select always
 * starts with "All tags", lists those tags alphabetically, and keeps a deep-
 * linked selection even when the latest server response no longer contains it.
 */

/** @typedef {{ value: string, label: string, temporary: boolean }} TagOption */

/**
 * Trim, de-duplicate and alphabetically sort server tags. Non-strings and blank
 * values are ignored so a defensive API client can never build empty options.
 *
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normalizeTagOptions(tags) {
  const list = Array.isArray(tags) ? tags : [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the complete option list for the Tag select. The first option is always
 * the empty "All tags" choice. When `selectedTag` is not in the server list it
 * is appended as a temporary option, preserving the URL/filter state.
 *
 * @param {unknown} serverTags
 * @param {unknown} [selectedTag]
 * @returns {TagOption[]}
 */
export function buildTagOptions(serverTags, selectedTag = '') {
  const tags = normalizeTagOptions(serverTags);
  const selected = typeof selectedTag === 'string' ? selectedTag.trim() : '';

  /** @type {TagOption[]} */
  const options = [{ value: '', label: 'All tags', temporary: false }];
  for (const tag of tags) {
    options.push({ value: tag, label: tag, temporary: false });
  }
  if (selected && !tags.includes(selected)) {
    options.push({ value: selected, label: selected, temporary: true });
  }
  return options;
}
