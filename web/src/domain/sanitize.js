// @ts-check

/**
 * Allowlist sanitizer for the HTML produced by `marked`.
 *
 * Parsing happens in a detached Document (provided via options or the global
 * document) built with DOMParser — never by assigning to the live document's
 * innerHTML. Only allowlisted tags/attributes survive, and anchor URL schemes
 * are validated (safe relative and fragment links are preserved).
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'del',
  'sup',
  'sub',
]);

const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'img',
  'template',
  'noscript',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'meta',
  'base',
]);

const VOID_TAGS = new Set(['br', 'hr']);
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Escape text for safe HTML insertion.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract a lower-case URL scheme, ignoring whitespace/control characters that
 * browsers tolerate inside obfuscated schemes (e.g. `java\nscript:`).
 *
 * @param {string} value
 * @returns {string}
 */
function schemeOf(value) {
  const cleaned = value.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*):/.exec(cleaned);
  return match ? `${match[1]}:` : '';
}

/**
 * Decide whether an anchor href is safe. Absolute URLs are limited to the
 * allowlisted schemes; schemeless URLs may be fragments or relative paths, but
 * protocol-relative URLs (`//host`) are rejected.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeHref(value) {
  const href = value.trim();
  if (!href) return false;

  if (schemeOf(href)) return LINK_SCHEMES.has(schemeOf(href));

  const compact = href.replace(/[\u0000-\u0020\u007f]+/g, '');
  // Browsers treat backslashes as slashes in special-scheme URLs, so
  // `//`, `/\`, `\/`, and `\\` all resolve as protocol-relative to a host.
  return !/^[/\\]{2}/.test(compact);
}

/**
 * @param {string[]} parts
 * @param {string} name
 * @param {unknown} value
 */
function pushAttribute(parts, name, value) {
  parts.push(`${name}="${escapeHtml(value)}"`);
}

/**
 * Serialize one element after validating its tag and attributes.
 *
 * @param {Element} element
 * @param {(node: Node) => string} sanitizeNode
 * @returns {string}
 */
function sanitizeElement(element, sanitizeNode) {
  const tagName = element.tagName.toLowerCase();

  if (DROP_WITH_CONTENT.has(tagName)) return '';
  if (!ALLOWED_TAGS.has(tagName)) {
    return Array.from(element.childNodes, sanitizeNode).join('');
  }

  /** @type {string[]} */
  const attributes = [];

  if (tagName === 'a') {
    const href = (element.getAttribute('href') ?? '').trim();
    if (isSafeHref(href)) {
      pushAttribute(attributes, 'href', href);
      const scheme = schemeOf(href);
      if (scheme === 'http:' || scheme === 'https:') {
        pushAttribute(attributes, 'rel', 'noopener noreferrer');
      }
    }
    const title = element.getAttribute('title');
    if (title) pushAttribute(attributes, 'title', title);
  } else {
    const title = element.getAttribute('title');
    if (title) pushAttribute(attributes, 'title', title);
    if (tagName === 'code' || tagName === 'pre') {
      const className = element.getAttribute('class');
      if (className) pushAttribute(attributes, 'class', className);
    }
    if (tagName === 'ol') {
      const start = element.getAttribute('start');
      if (start) pushAttribute(attributes, 'start', start);
    }
  }

  const attributeText = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  if (VOID_TAGS.has(tagName)) return `<${tagName}${attributeText}>`;

  const children = Array.from(element.childNodes, sanitizeNode).join('');
  return `<${tagName}${attributeText}>${children}</${tagName}>`;
}

/**
 * Sanitize HTML to a safe allowlisted string.
 *
 * @param {string} html
 * @param {{ document?: Document }} [options]
 * @returns {string}
 */
export function sanitizeHtml(html, options = {}) {
  if (!html) return '';

  const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return '';

  const Parser = doc.defaultView?.DOMParser ?? globalThis.DOMParser;
  if (!Parser) return '';

  const parsed = new Parser().parseFromString(String(html), 'text/html');

  /** @param {Node} node @returns {string} */
  function sanitizeNode(node) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      return escapeHtml(node.textContent);
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) {
      return '';
    }
    return sanitizeElement(/** @type {Element} */ (node), sanitizeNode);
  }

  return Array.from(parsed.body.childNodes, sanitizeNode).join('');
}
