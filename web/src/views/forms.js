// @ts-check
/**
 * Form validation helpers for the create/edit dialogs.
 *
 * These functions are pure and deterministic: callers pass plain values and get
 * back a field-keyed error map, or render that map as accessible inline errors.
 * They never fetch, read app state, or know about the API.
 */

/** @typedef {Object} SpaceFormValues
 * @property {string} [name]
 * @property {string} [description]
 * @property {string | string[]} [tags]
 */

/** @typedef {Object} MemoryFormValues
 * @property {string} [name]
 * @property {string} [content]
 * @property {string | string[]} [tags]
 * @property {number | string} [tier]
 */

const REQUIRED_SPACE_NAME = 'Enter a name for the space.';
const REQUIRED_MEMORY_NAME = 'Enter a name for the memory.';
const REQUIRED_MEMORY_CONTENT = 'Enter the memory content.';
const INVALID_TIER = 'Choose a tier between T1 and T3.';

const FIELD_ERROR_ATTR = 'data-field-error-for';

/**
 * @param {unknown} value
 * @returns {string}
 */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate the "new space" form values.
 *
 * @param {SpaceFormValues} [values]
 * @returns {Record<string, string>} error messages keyed by field name
 */
export function validateSpaceForm(values = {}) {
  /** @type {Record<string, string>} */
  const errors = {};
  if (!asTrimmedString(values.name)) errors.name = REQUIRED_SPACE_NAME;
  return errors;
}

/**
 * Validate the "new memory" form values.
 *
 * @param {MemoryFormValues} [values]
 * @returns {Record<string, string>} error messages keyed by field name
 */
export function validateMemoryForm(values = {}) {
  /** @type {Record<string, string>} */
  const errors = {};
  if (!asTrimmedString(values.name)) errors.name = REQUIRED_MEMORY_NAME;
  if (!asTrimmedString(values.content)) errors.content = REQUIRED_MEMORY_CONTENT;

  const tier = Number(values.tier);
  if (tier !== 1 && tier !== 2 && tier !== 3) errors.tier = INVALID_TIER;

  return errors;
}

/**
 * @param {Element} field
 * @returns {string}
 */
function errorElementId(field) {
  const key = field.getAttribute('name') || 'field';
  return `${field.id || key}-error`;
}

/**
 * Add or remove one id from a field's `aria-describedby` token list while
 * preserving any ids that were already there.
 *
 * @param {Element} field
 * @param {string} id
 * @param {boolean} present
 */
function setDescribedBy(field, id, present) {
  const tokens = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const next = new Set(tokens);
  if (present) next.add(id);
  else next.delete(id);

  if (next.size > 0) field.setAttribute('aria-describedby', Array.from(next).join(' '));
  else field.removeAttribute('aria-describedby');
}

/**
 * Find the inline error element for a field, creating it next to the field's
 * `.form-field` wrapper the first time it is needed.
 *
 * @param {Element} form
 * @param {Element} field
 * @param {string} key
 * @returns {Element}
 */
function ensureErrorElement(form, field, key) {
  const existing = form.querySelector(`[${FIELD_ERROR_ATTR}="${key}"]`);
  if (existing) return existing;

  const node = field.ownerDocument.createElement('p');
  node.className = 'form-error';
  node.id = errorElementId(field);
  node.setAttribute(FIELD_ERROR_ATTR, key);
  node.setAttribute('role', 'alert');

  const wrapper = field.closest('.form-field');
  if (wrapper) wrapper.appendChild(node);
  else field.insertAdjacentElement('afterend', node);

  return node;
}

/**
 * @param {Element} form
 * @param {Element} field
 * @param {string} message
 */
function applyFieldError(form, field, message) {
  const key = field.getAttribute('name');
  if (!key) return;

  const node = ensureErrorElement(form, field, key);
  node.textContent = message;
  node.removeAttribute('hidden');

  field.setAttribute('aria-invalid', 'true');
  setDescribedBy(field, errorElementId(field), true);
}

/**
 * @param {Element} form
 * @param {Element} field
 */
function clearFieldError(form, field) {
  field.removeAttribute('aria-invalid');

  const key = field.getAttribute('name');
  if (!key) return;

  setDescribedBy(field, errorElementId(field), false);

  const node = form.querySelector(`[${FIELD_ERROR_ATTR}="${key}"]`);
  if (!node) return;
  node.textContent = '';
  node.setAttribute('hidden', '');
}

/**
 * Render an error map onto a form container's named fields. Each message is
 * linked to its field through `aria-describedby`, and the field is marked with
 * `aria-invalid`. Fields without a message are cleared.
 *
 * @param {Element} form container holding the named fields
 * @param {Record<string, string>} [errors] messages keyed by field name
 * @returns {boolean} true when there are no messages to show
 */
export function renderFormErrors(form, errors = {}) {
  const fields = form.querySelectorAll('[name]');
  for (const field of fields) {
    const key = field.getAttribute('name');
    const message = key ? errors[key] : undefined;
    if (message) applyFieldError(form, field, message);
    else clearFieldError(form, field);
  }

  return !Object.values(errors).some(
    message => typeof message === 'string' && message.trim() !== ''
  );
}
