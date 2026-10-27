// Recall policy for natural-language searches; explicit boolean searches remain strict.
import { stripDiacritics } from './matching-tokenizer';
import type { ParsedQuery } from './query-parser';
import { canBypassLexicalAdmission } from './semantic-admission';

const STOPWORDS = new Set(
  (
    'a about an and are as at be been but by did do does for from had has have how i in ' +
    'is it its me my of on or our she that the their them there these they this to ' +
    'was were what when where which who why will with would you your ' +
    'al algo como con de del el ella ellas ellos en es esa ese eso esta estas este ' +
    'estos ha hay la las le les lo los mi mis para por que se ser si sin su sus ' +
    'tu tus un una unas uno unos y ya'
  ).split(' ')
);

/** Unicode-aware word runs, so non-Latin scripts are never treated as empty. */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/** Broaden sufficiently specific plain questions, not intentional keyword searches. */
export function isNaturalLanguageRecall(ast: ParsedQuery): boolean {
  // Parsed provenance decides intent: an explicit uppercase AND is boolean
  // syntax, while a lowercase `and` inside a question is just an ordinary word
  // (the stopword filter drops it later).
  if (ast.degraded || !canBypassLexicalAdmission(ast)) return false;
  return /[?¿]/.test(ast.raw);
}

/** Folded, Unicode-aware words of arbitrary query text (keeps Cyrillic/Greek/CJK). */
export function queryWords(text: string): string[] {
  return stripDiacritics(text).toLowerCase().match(WORD_PATTERN) ?? [];
}

/** The single stopword predicate shared by recall terms and validation. */
export function isInformativeQueryTerm(term: string): boolean {
  return !STOPWORDS.has(term);
}

/** Stopwords cannot independently qualify a memory for broad recall. */
export function informativeSearchTokens(tokens: readonly string[]): string[] {
  return tokens.filter(isInformativeQueryTerm);
}

/**
 * True when the query's positive text contains at least one informative word.
 *
 * Uses Unicode word detection rather than the ASCII matcher tokenizer so a
 * query written in a supported non-Latin script is not falsely classified as
 * empty. Stopwords are still matched after English/Spanish diacritic folding.
 */
export function hasInformativeQueryTerms(ast: ParsedQuery): boolean {
  for (const group of ast.groups) {
    for (const node of group.nodes) {
      const text = node.type === 'phrase' ? node.text : node.token;
      if (queryWords(text).some(isInformativeQueryTerm)) return true;
    }
  }
  return false;
}

/** Input is always the canonical tokenizer's normalized, safe lexical terms. */
export function buildInformativeAnyMatch(tokens: readonly string[]): string {
  return tokens.map(token => '"' + token + '"').join(' OR ');
}
