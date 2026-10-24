// @ts-check
/**
 * Lightweight pretty-JSON highlighter for the memory panel.
 *
 * `parseJsonContent` accepts only JSON objects and arrays (a memory whose
 * trimmed content starts with `{` or `[`). `tokenizeJson` scans the canonical
 * `JSON.stringify(value, null, 2)` output and returns plain text tokens for a
 * view to turn into spans. It never produces or interprets HTML, so callers
 * must assign token text with `textContent`.
 */

/** @typedef {'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space'} JsonTokenType */

/** @typedef {{ type: JsonTokenType, text: string }} JsonToken */

/**
 * Parse memory content as a JSON object or array.
 *
 * @param {unknown} content
 * @returns {unknown[] | Record<string, unknown> | null}
 */
export function parseJsonContent(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Serialize a parsed JSON value with two-space indentation.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function prettyPrintJson(value) {
  return JSON.stringify(value, null, 2) ?? '';
}

/**
 * Split pretty-printed JSON into typed tokens whose concatenated text is the
 * original string. Whitespace is preserved as `space` tokens.
 *
 * @param {string} source
 * @returns {JsonToken[]}
 */
export function tokenizeJson(source) {
  /** @type {JsonToken[]} */
  const tokens = [];
  let index = 0;

  /** @param {JsonTokenType} type @param {string} text */
  function push(type, text) {
    if (text) tokens.push({ type, text });
  }

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      const start = index;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      push('space', source.slice(start, index));
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (current === '"') break;
      }
      const text = source.slice(start, index);

      let lookahead = index;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      push(source[lookahead] === ':' ? 'key' : 'string', text);
      continue;
    }

    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (number) {
      push('number', number[0]);
      index += number[0].length;
      continue;
    }

    if (source.startsWith('true', index) || source.startsWith('false', index)) {
      const text = source[index] === 't' ? 'true' : 'false';
      push('boolean', text);
      index += text.length;
      continue;
    }

    if (source.startsWith('null', index)) {
      push('null', 'null');
      index += 4;
      continue;
    }

    // Braces, brackets, commas, colons, and anything unexpected.
    push('punct', char);
    index += 1;
  }

  return tokens;
}
