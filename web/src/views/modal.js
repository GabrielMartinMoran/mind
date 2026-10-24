// @ts-check
/**
 * Accessible native `<dialog>` controller shared by the create/edit modals.
 *
 * `createModal` owns exactly one dialog and its generic behavior: modal
 * open/close, trigger focus return, Escape/backdrop dismissal, and one alert
 * region for request errors. It never fetches, reads app state or knows about a
 * specific form; Task 5C2 wires open/close and the submit flow into the app.
 */

/** @typedef {Object} ModalOptions
 * @property {HTMLDialogElement} [dialog]
 * @property {Document} [document]
 */

/** @typedef {Object} ModalOpenOptions
 * @property {Element | null} [trigger]
 */

const ERROR_SELECTOR = '[data-modal-error]';
const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Try again.';

/**
 * Create a modal controller for one dialog element.
 *
 * @param {ModalOptions} [options]
 * @returns {{
 *   open: (options?: ModalOpenOptions) => void,
 *   close: () => void,
 *   isOpen: () => boolean,
 *   setError: (message?: string) => void,
 *   clearError: () => void,
 *   destroy: () => void,
 * }}
 */
export function createModal(options = {}) {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) throw new Error('createModal requires a document');

  const dialog = options.dialog;
  if (!dialog) throw new Error('createModal requires a dialog element');

  /** @type {Element | null} */
  let trigger = null;
  let isOpenFlag = false;
  let destroyed = false;

  /**
   * Resolve the alert region, optionally creating a fallback when the markup
   * does not provide one.
   *
   * @param {boolean} [create]
   * @returns {Element | null}
   */
  function errorRegion(create = true) {
    const existing = dialog.querySelector(ERROR_SELECTOR);
    if (existing || !create) return existing;

    const node = doc.createElement('p');
    node.className = 'form-error';
    node.setAttribute('data-modal-error', '');
    node.setAttribute('role', 'alert');
    node.setAttribute('hidden', '');

    const container = dialog.querySelector('[data-modal-form]') ?? dialog;
    container.prepend(node);
    return node;
  }

  /** @returns {Element | null} */
  function firstField() {
    return (
      dialog.querySelector('[autofocus]') ??
      dialog.querySelector('input:not([type="hidden"]), select, textarea') ??
      dialog.querySelector('[tabindex], button, a[href]')
    );
  }

  /** Ensure the dialog has an accessible name from its heading. */
  function ensureLabelledBy() {
    if (dialog.hasAttribute('aria-labelledby')) return;

    const heading = dialog.querySelector('h1, h2, h3');
    if (!heading) return;

    if (!heading.id) heading.id = `${dialog.id || 'modal'}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }

  /** Reveal the dialog as a modal, falling back to the `open` attribute. */
  function showDialog() {
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

  /** Hide the dialog without touching focus. */
  function hideDialog() {
    if (typeof dialog.close === 'function' && (dialog.open || dialog.hasAttribute('open'))) {
      try {
        dialog.close();
      } catch {
        // Ignore and clear the attribute below.
      }
    }
    if (dialog.hasAttribute('open')) dialog.removeAttribute('open');
  }

  /** Return focus to the element that opened the dialog, when still connected. */
  function restoreFocus() {
    const target = trigger;
    trigger = null;
    if (!target || target.isConnected === false) return;

    const focusable = /** @type {HTMLElement} */ (target);
    if (typeof focusable.focus === 'function') focusable.focus();
  }

  /** @param {ModalOpenOptions} [openOptions] */
  function open(openOptions = {}) {
    if (destroyed) return;

    trigger = openOptions.trigger ?? null;
    clearError();
    ensureLabelledBy();
    showDialog();
    isOpenFlag = true;

    const field = firstField();
    if (field) {
      const focusable = /** @type {HTMLElement} */ (field);
      if (typeof focusable.focus === 'function') focusable.focus();
    }
  }

  function close() {
    hideDialog();
    isOpenFlag = false;
    restoreFocus();
  }

  /** @param {string} [message] */
  function setError(message) {
    const region = errorRegion(true);
    if (!region) return;

    region.textContent = message || DEFAULT_ERROR_MESSAGE;
    region.removeAttribute('hidden');
  }

  function clearError() {
    const region = errorRegion(false);
    if (!region) return;

    region.textContent = '';
    region.setAttribute('hidden', '');
  }

  /** @param {Event} event */
  function onClick(event) {
    if (destroyed) return;
    if (event.target === dialog) close();
  }

  /** @param {Event} event */
  function onCancel(event) {
    event.preventDefault();
    close();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (destroyed) return;
    if (event.key !== 'Escape') return;
    if (!isOpenFlag && !dialog.hasAttribute('open')) return;

    event.preventDefault();
    close();
  }

  function isOpen() {
    return isOpenFlag || dialog.open === true || dialog.hasAttribute('open');
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    dialog.removeEventListener('click', onClick);
    dialog.removeEventListener('cancel', onCancel);
    doc.removeEventListener('keydown', /** @type {EventListener} */ (onKeydown));
  }

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('cancel', onCancel);
  doc.addEventListener('keydown', /** @type {EventListener} */ (onKeydown));

  return { open, close, isOpen, setError, clearError, destroy };
}
