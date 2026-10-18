// ── Query parser (D2) ──
//
// Parses free-text user input into a structured AST and builds safe FTS5 MATCH
// expressions from it. Raw FTS5 syntax is never passed through: quotes, OR,
// AND (= implicit AND), NOT and trailing `*` are the only supported operators.
// Anything malformed degrades to a literal-AND fallback — parsing never throws.

import { normalizeToken } from './matching-tokenizer';

/** A single matchable node: a term (optionally prefix) or a quoted phrase. */
export type QueryNode =
  | { type: 'term'; token: string; prefix: boolean }
  | { type: 'phrase'; text: string };

/** A conjunction (AND) of nodes. Groups are combined with OR. */
export interface QueryGroup {
  nodes: QueryNode[];
}

export interface ParsedQuery {
  raw: string;
  /** OR-combined groups; each group is an AND of nodes. */
  groups: QueryGroup[];
  /** NOT-excluded nodes. */
  exclude: QueryNode[];
  /** True when the input was malformed and fell back to literal AND. */
  degraded: boolean;
}

/** Relaxation-rung identifiers produced from a parsed query. */
export type RungMethod = 'phrase' | 'all' | 'any';

export interface QueryRung {
  method: RungMethod;
  match: string;
}

interface RawToken {
  kind: 'word' | 'phrase';
  value: string;
  prefix: boolean;
}

const NOT_OPERATOR = 'NOT';
const OR_OPERATOR = 'OR';
const AND_OPERATOR = 'AND';

function isOperator(token: RawToken, operator: string): boolean {
  return token.kind === 'word' && !token.prefix && token.value.toUpperCase() === operator;
}

function toNode(token: RawToken): QueryNode {
  return token.kind === 'phrase'
    ? { type: 'phrase', text: token.value }
    : { type: 'term', token: normalizeToken(token.value), prefix: token.prefix };
}

/** Split raw input into word/phrase tokens, flagging malformed quoting. */
function scan(input: string): { tokens: RawToken[]; malformed: boolean } {
  const tokens: RawToken[] = [];
  let malformed = false;
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const end = input.indexOf('"', index + 1);
      if (end === -1) {
        malformed = true;
        const rest = input.slice(index + 1).trim();
        if (rest) tokens.push({ kind: 'word', value: rest, prefix: false });
        break;
      }
      const value = input.slice(index + 1, end);
      if (value.length === 0) malformed = true;
      else tokens.push({ kind: 'phrase', value, prefix: false });
      index = end + 1;
      continue;
    }

    let end = index;
    while (end < input.length && !/\s/.test(input[end]!) && input[end] !== '"') end += 1;
    if (end < input.length && input[end] === '"') malformed = true;

    let word = input.slice(index, end);
    index = end;
    const prefix = word.endsWith('*');
    if (prefix) word = word.slice(0, -1);
    if (word.length === 0) {
      if (prefix) malformed = true;
      continue;
    }
    tokens.push({ kind: 'word', value: word, prefix });
  }

  return { tokens, malformed };
}

function degrade(raw: string, tokens: RawToken[]): ParsedQuery {
  if (tokens.length === 0) return { raw, groups: [], exclude: [], degraded: true };
  return { raw, groups: [{ nodes: tokens.map(toNode) }], exclude: [], degraded: true };
}

/**
 * Parse user input into a {@link ParsedQuery}. Malformed input never throws; it
 * degrades to a literal AND of the raw tokens.
 */
export function parseQuery(input: string): ParsedQuery {
  const raw = input;
  if (!input.trim()) return { raw, groups: [], exclude: [], degraded: false };

  const { tokens, malformed } = scan(input);
  if (malformed) return degrade(raw, tokens);

  const groups: QueryGroup[] = [];
  const exclude: QueryNode[] = [];
  let current: QueryNode[] = [];
  let pendingExclude = false;
  let invalid = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (isOperator(token, AND_OPERATOR)) continue;

    if (isOperator(token, NOT_OPERATOR)) {
      if (index === tokens.length - 1) {
        invalid = true;
        break;
      }
      pendingExclude = true;
      continue;
    }

    if (isOperator(token, OR_OPERATOR)) {
      if (current.length === 0) {
        invalid = true;
        break;
      }
      groups.push({ nodes: current });
      current = [];
      pendingExclude = false;
      continue;
    }

    const node = toNode(token);
    if (pendingExclude) {
      exclude.push(node);
      pendingExclude = false;
    } else {
      current.push(node);
    }
  }

  if (pendingExclude) invalid = true;
  if (current.length > 0) groups.push({ nodes: current });

  // Malformed operator usage or no positive group ⇒ literal-AND fallback.
  if (invalid || groups.length === 0) return degrade(raw, tokens);

  return { raw, groups, exclude, degraded: false };
}

/** True when the query carries no positive or negative matchable nodes. */
export function isEmptyQuery(ast: ParsedQuery): boolean {
  return ast.groups.length === 0 && ast.exclude.length === 0;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

function nodeToMatch(node: QueryNode): string {
  if (node.type === 'phrase') return quote(node.text);
  return node.prefix ? `${quote(node.token)}*` : quote(node.token);
}

function excludeClause(exclude: QueryNode[]): string | null {
  return exclude.length > 0 ? exclude.map(nodeToMatch).join(' OR ') : null;
}

/** FTS5 MATCH honoring OR / AND / NOT / prefix / phrase (the `all` rung). */
export function buildPrimaryMatch(ast: ParsedQuery): string {
  const groups = ast.groups.map(group => group.nodes.map(nodeToMatch).join(' ')).filter(Boolean);
  if (groups.length === 0) return '';

  let expression = groups.length === 1 ? groups[0]! : `(${groups.join(' OR ')})`;
  const not = excludeClause(ast.exclude);
  if (not) expression = `(${expression}) NOT (${not})`;
  return expression;
}

/** FTS5 phrase MATCH for a single group of adjacent terms, or null (the `phrase` rung). */
export function buildPhraseMatch(ast: ParsedQuery): string | null {
  if (ast.groups.length !== 1) return null;
  const nodes = ast.groups[0]!.nodes;
  const isSinglePhrase = nodes.length === 1 && nodes[0]!.type === 'phrase';
  if (nodes.length < 2 && !isSinglePhrase) return null;

  const text = nodes
    .map(node => (node.type === 'phrase' ? node.text : node.token))
    .join(' ')
    .trim();
  if (!text) return null;

  let expression = quote(text);
  const not = excludeClause(ast.exclude);
  if (not) expression = `(${expression}) NOT (${not})`;
  return expression;
}

/** FTS5 OR-union MATCH over all positive nodes, or null (the `any` rung). */
export function buildAnyMatch(ast: ParsedQuery): string | null {
  const nodes = ast.groups.flatMap(group => group.nodes);
  if (nodes.length === 0) return null;

  const parts = nodes.map(nodeToMatch);
  let expression = parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  const not = excludeClause(ast.exclude);
  if (not) expression = `(${expression}) NOT (${not})`;
  return expression;
}

/**
 * Build the ordered relaxation rungs for a parsed query. Duplicate MATCH
 * expressions collapse to the first (strongest) rung, so single-term queries
 * produce a single rung identical to the legacy behavior.
 */
export function buildRungs(ast: ParsedQuery): QueryRung[] {
  const rungs: QueryRung[] = [];
  const seen = new Set<string>();
  const add = (method: RungMethod, match: string | null): void => {
    if (match && !seen.has(match)) {
      seen.add(match);
      rungs.push({ method, match });
    }
  };

  add('phrase', buildPhraseMatch(ast));
  add('all', buildPrimaryMatch(ast) || null);
  add('any', buildAnyMatch(ast));
  return rungs;
}
