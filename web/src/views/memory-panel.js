// @ts-check
/**
 * Memory panel view/controller.
 *
 * `createMemoryPanel` owns one native `<dialog>` and its dependent elements. It
 * renders a memory (markdown through `marked`, then the allowlist sanitizer),
 * manages loading/error/edit states, and dispatches user actions to injected
 * handlers. It never fetches, reads app state or touches the URL: in Task 5B2
 * the app controller subscribes to the handlers and calls `open`/`close`.
 */

import { parseJsonContent, prettyPrintJson, tokenizeJson } from '../domain/json-viewer.js';
import { tierLabel } from '../domain/memory-model.js';
import { sanitizeHtml } from '../domain/sanitize.js';

import { createIcon } from './icon.js';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** @typedef {Object} MemoryLike
 * @property {string} [name]
 * @property {string} [space_name]
 * @property {string} [content]
 * @property {number} [tier]
 * @property {boolean} [pinned]
 * @property {string[]} [tags]
 * @property {string} [changed_at]
 */

/** @typedef {Object} MemoryPanelHandlers
 * @property {() => void} [onClose]
 * @property {() => void} [onEdit]
 * @property {(content: string) => void} [onSave]
 * @property {() => void} [onCancelEdit]
 * @property {() => void} [onPin]
 * @property {() => void} [onPromote]
 * @property {() => void} [onDemote]
 * @property {() => void} [onAddTag]
 * @property {(tag: string) => void} [onAddTagSubmit]
 * @property {(tag: string) => void} [onRemoveTag]
 * @property {() => void} [onDelete]
 * @property {() => void} [onRetry]
 */

/** @typedef {Object} MemoryPanelOptions
 * @property {HTMLDialogElement} [dialog]
 * @property {Document} [document]
 * @property {MemoryPanelHandlers} [handlers]
 */

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
 * @param {number | undefined} tier
 * @returns {string}
 */
function tierClass(tier) {
  return tier === 1 || tier === 2 || tier === 3 ? `t${tier}` : '';
}

/**
 * Resolve the `marked` global exposed on the panel document's window (or the
 * module global in non-browser environments).
 *
 * @param {Document} doc
 * @returns {{ parse: (markdown: string) => string } | null}
 */
function resolveMarked(doc) {
  const fromWindow = /** @type {any} */ (doc.defaultView)?.marked;
  const fromGlobal = /** @type {any} */ (globalThis).marked;
  const candidate = fromWindow ?? fromGlobal;
  return candidate && typeof candidate.parse === 'function' ? candidate : null;
}

/**
 * Create the memory panel controller for one dialog element.
 *
 * @param {MemoryPanelOptions} [options]
 * @returns {{
 *   open: (memory: MemoryLike, options?: { trigger?: Element | null }) => void,
 *   show: (options?: { trigger?: Element | null }) => void,
 *   close: () => void,
 *   render: (memory: MemoryLike) => void,
 *   setLoading: () => void,
 *   setError: (message?: string) => void,
 *   setEditMode: (enabled: boolean) => void,
 *   isOpen: () => boolean,
 *   destroy: () => void,
 * }}
 */
export function createMemoryPanel(options = {}) {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) throw new Error('createMemoryPanel requires a document');

  const dialog =
    options.dialog ?? /** @type {HTMLDialogElement | null} */ (doc.getElementById('memory-panel'));
  if (!dialog) throw new Error('createMemoryPanel requires a #memory-panel dialog');

  const handlers = options.handlers ?? {};
  const tagInputElement = byId('mem-tag-input');

  /** @type {MemoryLike | null} */
  let currentMemory = null;
  /** @type {Element | null} */
  let trigger = null;
  let isOpenFlag = false;
  let closeRequested = false;
  let destroyed = false;

  /**
   * Look an element up inside the panel first, then the document.
   *
   * @param {string} id
   * @returns {any}
   */
  function byId(id) {
    const scoped = dialog.querySelector(`#${id}`);
    if (scoped) return scoped;
    return doc.getElementById(id);
  }

  /**
   * @param {string} tagName
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function element(tagName, className, text) {
    const node = doc.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return /** @type {HTMLElement} */ (node);
  }

  /**
   * @param {string} id
   * @param {string} className
   * @param {string} text
   * @returns {HTMLButtonElement}
   */
  function button(id, className, text) {
    const node = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
    node.type = 'button';
    if (id) node.id = id;
    node.className = className;
    node.textContent = text;
    return node;
  }

  /** @param {Element | null} node */
  function toggleHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle('hidden', hidden);
  }

  /**
   * @param {MemoryLike} memory
   */
  function renderTitle(memory) {
    const title = byId('mem-title');
    if (title) title.textContent = memory.name ?? '';
  }

  /**
   * @param {MemoryLike} memory
   */
  function renderTier(memory) {
    const badge = byId('mem-tier-badge');
    if (!badge) return;

    if (memory.tier === 1 || memory.tier === 2 || memory.tier === 3) {
      badge.textContent = `T${memory.tier}`;
      badge.className = `tier-badge ${tierClass(memory.tier)}`;
      badge.setAttribute('title', tierLabel(memory.tier));
    } else {
      badge.textContent = '';
      badge.className = 'tier-badge';
      badge.removeAttribute('title');
    }
  }

  /**
   * @param {MemoryLike} memory
   */
  function renderChanged(memory) {
    const changed = byId('mem-changed');
    if (!changed) return;
    const label = changedLabel(memory.changed_at);
    changed.textContent = label ? `Changed ${label}` : '';
    toggleHidden(changed, !label);
  }

  /**
   * @param {MemoryLike} memory
   */
  function renderPinned(memory) {
    const pinned = Boolean(memory.pinned);

    const indicator = byId('mem-pinned');
    if (indicator) {
      indicator.textContent = 'Pinned';
      toggleHidden(indicator, !pinned);
    }

    const pinButton = byId('btn-mem-pin');
    if (!pinButton) return;
    pinButton.setAttribute('aria-pressed', String(pinned));
    pinButton.setAttribute('aria-label', pinned ? 'Unpin memory' : 'Pin memory');
    const label = pinButton.querySelector('.pin-label');
    if (label) label.textContent = pinned ? 'Unpin' : 'Pin';
  }

  /**
   * Render tag chips as real buttons plus an add-tag control.
   *
   * @param {MemoryLike} memory
   */
  function renderTags(memory) {
    const row = byId('mem-tags-row');
    if (!row) return;

    row.textContent = '';
    const tags = Array.isArray(memory.tags) ? memory.tags : [];

    for (const tag of tags) {
      const chip = button('', 'tag', `#${tag}`);
      chip.dataset.action = 'remove-tag';
      chip.dataset.tag = String(tag);
      chip.title = `Remove tag #${tag}`;
      chip.setAttribute('aria-label', `Remove tag ${tag}`);
      chip.appendChild(createIcon('x', { document: doc, size: 'sm' }));
      row.appendChild(chip);
    }

    const add = button('', 'tag-add', '+ tag');
    add.dataset.action = 'add-tag';
    add.setAttribute('aria-label', 'Add tag');
    add.prepend(createIcon('tag', { document: doc, size: 'sm' }));
    row.appendChild(add);
  }

  /** Reveal the inline tag input and focus it; the app owns the PATCH. */
  function showTagInput() {
    const row = byId('mem-tag-input-row');
    const input = byId('mem-tag-input');
    if (!row || !input) return;

    row.classList.remove('hidden');
    input.value = '';
    if (typeof input.focus === 'function') input.focus();
  }

  /**
   * Hide the inline tag input. Focus returns to the add-tag control by default,
   * so a cancelled entry never strands the keyboard user.
   *
   * @param {{ restoreFocus?: boolean }} [options]
   */
  function hideTagInput(options = {}) {
    const { restoreFocus = true } = options;
    const row = byId('mem-tag-input-row');
    const input = byId('mem-tag-input');
    if (row) row.classList.add('hidden');
    if (input) input.value = '';
    if (!restoreFocus) return;

    const add = byId('mem-tags-row')?.querySelector('[data-action="add-tag"]');
    if (add && typeof add.focus === 'function') /** @type {HTMLElement} */ (add).focus();
  }

  /** Commit the inline tag input value through the app handler. */
  function submitTagInput() {
    const input = byId('mem-tag-input');
    const value = String(input?.value ?? '').trim();
    hideTagInput();
    if (!value) return;
    handlers.onAddTagSubmit?.(value);
  }

  /** @param {KeyboardEvent} event */
  function onTagInputKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      submitTagInput();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideTagInput();
    }
  }

  /**
   * Render a valid JSON object/array as pretty text. Every token is appended
   * with `textContent` (or as a text node), never `innerHTML`, so JSON strings
   * that contain HTML stay inert. The `<pre>` keeps the raw pretty document
   * selectable and copyable.
   *
   * @param {HTMLElement} content
   * @param {string} raw
   * @returns {boolean} whether JSON rendering took over
   */
  function renderJsonContent(content, raw) {
    const parsed = parseJsonContent(raw);
    if (parsed === null) return false;

    const pre = /** @type {HTMLPreElement} */ (doc.createElement('pre'));
    pre.className = 'json-viewer';
    for (const token of tokenizeJson(prettyPrintJson(parsed))) {
      if (token.type === 'space') {
        pre.appendChild(doc.createTextNode(token.text));
        continue;
      }
      const span = element('span', `json-${token.type}`, token.text);
      pre.appendChild(span);
    }

    content.textContent = '';
    content.appendChild(pre);
    return true;
  }

  /**
   * Render markdown through `marked` and the allowlist sanitizer. The sanitized
   * string is parsed in an inert `<template>` and its nodes are appended, so
   * user content is never assigned to the live panel with `innerHTML`.
   *
   * @param {MemoryLike} memory
   */
  function renderContent(memory) {
    const content = byId('mem-content');
    if (!content) return;

    content.classList.remove('hidden');
    const raw = typeof memory.content === 'string' ? memory.content : '';
    if (renderJsonContent(content, raw)) return;
    const marked = resolveMarked(doc);

    if (marked) {
      let html = '';
      try {
        html = marked.parse(raw);
      } catch {
        html = '';
      }

      if (typeof html === 'string' && html) {
        const safe = sanitizeHtml(html, { document: doc });
        const template = /** @type {HTMLTemplateElement} */ (doc.createElement('template'));
        template.innerHTML = safe;
        content.textContent = '';
        content.appendChild(template.content.cloneNode(true));
        return;
      }
    }

    content.textContent = raw;
  }

  /** @param {boolean} enabled */
  function setEditMode(enabled) {
    const control = byId('mem-edit-area');
    const content = byId('mem-content');
    const state = byId('mem-state');
    const input = byId('mem-edit-input');

    if (enabled) {
      toggleHidden(state, true);
      toggleHidden(content, true);
      toggleHidden(control, false);
      if (input) {
        input.value = currentMemory?.content ?? '';
        input.focus();
      }
      return;
    }

    toggleHidden(control, true);
    toggleHidden(content, false);
  }

  /**
   * @param {MemoryLike} memory
   */
  function render(memory) {
    currentMemory = memory;

    dialog.setAttribute('aria-labelledby', 'mem-title');
    dialog.removeAttribute('aria-busy');
    toggleHidden(byId('mem-state'), true);

    renderTitle(memory);
    renderTier(memory);
    renderChanged(memory);
    renderPinned(memory);
    renderTags(memory);
    renderContent(memory);
    setEditMode(false);
    hideTagInput({ restoreFocus: false });
  }

  function setLoading() {
    const state = byId('mem-state');
    const content = byId('mem-content');

    dialog.setAttribute('aria-busy', 'true');
    toggleHidden(content, true);
    toggleHidden(byId('mem-edit-area'), true);
    if (!state) return;

    state.textContent = '';
    state.className = 'mem-state';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');

    state.appendChild(element('p', 'visually-hidden', 'Loading memory…'));

    const skeleton = element('div', 'mem-skeleton');
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.appendChild(element('div', 'mem-skeleton-line mem-skeleton-title'));
    skeleton.appendChild(element('div', 'mem-skeleton-line'));
    skeleton.appendChild(element('div', 'mem-skeleton-line mem-skeleton-short'));
    skeleton.appendChild(element('div', 'mem-skeleton-line'));
    state.appendChild(skeleton);
  }

  /** @param {string} [message] */
  function setError(message) {
    const state = byId('mem-state');
    const content = byId('mem-content');

    dialog.setAttribute('aria-busy', 'false');
    toggleHidden(content, true);
    toggleHidden(byId('mem-edit-area'), true);
    if (!state) return;

    state.textContent = '';
    state.className = 'mem-state';
    state.setAttribute('role', 'alert');
    state.removeAttribute('aria-live');

    state.appendChild(
      element('p', 'mem-error-message', message || 'The memory could not be loaded. Try again.')
    );

    const retry = button('mem-retry', 'btn btn-sm btn-secondary mem-retry', 'Try again');
    retry.dataset.action = 'retry';
    retry.prepend(createIcon('rotate-ccw', { document: doc }));
    state.appendChild(retry);
  }

  function focusInitial() {
    const closeButton = byId('btn-mem-close-inline') ?? byId('btn-mem-close');
    if (closeButton && typeof closeButton.focus === 'function') {
      closeButton.focus();
      return;
    }

    const title = byId('mem-title');
    if (!title) return;
    if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
    title.focus();
  }

  function showDialog() {
    if (dialog.open || dialog.hasAttribute('open')) return;

    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
        return;
      } catch {
        // Fall through to the attribute-based fallback.
      }
    }

    dialog.setAttribute('open', '');
  }

  function hideDialog() {
    if (typeof dialog.close === 'function' && (dialog.open || dialog.hasAttribute('open'))) {
      try {
        dialog.close();
      } catch {
        // Ignore and remove the attribute below.
      }
    }
    if (dialog.hasAttribute('open')) dialog.removeAttribute('open');
  }

  function restoreFocus() {
    const target = /** @type {any} */ (trigger);
    trigger = null;
    if (!target) return;
    if (target.isConnected === false) return;
    if (typeof target.focus === 'function') target.focus();
  }

  /**
   * UI-initiated close: let the controller react first. Without an `onClose`
   * handler the panel closes itself, which keeps the view usable standalone.
   */
  function requestClose() {
    if (closeRequested) return;
    if (!isOpenFlag && !dialog.hasAttribute('open')) return;

    closeRequested = true;
    if (typeof handlers.onClose === 'function') {
      handlers.onClose();
      return;
    }
    close();
  }

  /**
   * Open the dialog without rendering a memory. The app controller uses this to
   * reveal the loading or error state before the detail arrives; the dialog is
   * then populated with `render` (and left open) once the request settles.
   *
   * @param {{ trigger?: Element | null }} [openOptions]
   */
  function show(openOptions = {}) {
    if (destroyed) return;

    trigger = openOptions.trigger ?? null;
    closeRequested = false;

    showDialog();
    isOpenFlag = true;
    focusInitial();
  }

  /**
   * @param {MemoryLike} memory
   * @param {{ trigger?: Element | null }} [openOptions]
   */
  function open(memory, openOptions = {}) {
    if (destroyed) return;

    render(memory);
    show(openOptions);
  }

  function close() {
    hideDialog();
    isOpenFlag = false;
    closeRequested = false;
    setEditMode(false);
    hideTagInput({ restoreFocus: false });
    restoreFocus();
  }

  /** @param {Event} event */
  function onClick(event) {
    if (destroyed) return;

    const target = /** @type {any} */ (event.target);
    if (target === dialog) {
      requestClose();
      return;
    }
    if (!target || typeof target.closest !== 'function') return;

    const actionElement = target.closest('[data-action]');
    if (!actionElement || !dialog.contains(actionElement)) return;

    const action = actionElement.dataset.action;
    switch (action) {
      case 'close':
        requestClose();
        break;
      case 'edit':
        setEditMode(true);
        handlers.onEdit?.();
        break;
      case 'save':
        handlers.onSave?.(String(byId('mem-edit-input')?.value ?? ''));
        break;
      case 'cancel-edit':
        setEditMode(false);
        handlers.onCancelEdit?.();
        break;
      case 'pin':
        handlers.onPin?.();
        break;
      case 'promote':
        handlers.onPromote?.();
        break;
      case 'demote':
        handlers.onDemote?.();
        break;
      case 'add-tag':
        handlers.onAddTag?.();
        showTagInput();
        break;
      case 'add-tag-confirm':
        submitTagInput();
        break;
      case 'remove-tag':
        handlers.onRemoveTag?.(String(actionElement.dataset.tag ?? ''));
        break;
      case 'delete':
        handlers.onDelete?.();
        break;
      case 'retry':
        handlers.onRetry?.();
        break;
      default:
        break;
    }
  }

  /** @param {Event} event */
  function onCancel(event) {
    event.preventDefault();
    requestClose();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (!isOpenFlag && !dialog.hasAttribute('open')) return;
    // Another dialog (the delete confirmation) may be stacked above the panel.
    // Let the topmost dialog own Escape so one key press closes only one dialog.
    if (doc.querySelectorAll('dialog[open]').length > 1) return;
    event.preventDefault();
    requestClose();
  }

  function isOpen() {
    return isOpenFlag || dialog.open === true || dialog.hasAttribute('open');
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dialog.removeEventListener('click', onClick);
    dialog.removeEventListener('cancel', onCancel);
    doc.removeEventListener('keydown', /** @type {any} */ (onKeydown));
    tagInputElement?.removeEventListener('keydown', onTagInputKeydown);
  }

  tagInputElement?.addEventListener('keydown', onTagInputKeydown);

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('cancel', onCancel);
  doc.addEventListener('keydown', /** @type {any} */ (onKeydown));

  return {
    open,
    show,
    close,
    render,
    setLoading,
    setError,
    setEditMode,
    isOpen,
    destroy,
  };
}
