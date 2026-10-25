// Recall policy for natural-language searches; explicit boolean searches remain strict.
import type { ParsedQuery } from './query-parser';
import { canBypassLexicalAdmission } from './semantic-admission';

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by did do does for from had has have how i in ' +
    'is it its me my of on or our she that the their them there these they this to ' +
    'was were what when where which who why will with would you your ' +
    'al algo como con de del el ella ellas ellos en es esa ese eso esta estas este ' +
    'estos ha hay la las le les lo los mi mis para por que se ser si sin su sus ' +
    'tu tus un una unas uno unos y ya'
  ).split(' ')
);

/** Broaden sufficiently specific plain questions, not intentional keyword searches. */
export function isNaturalLanguageRecall(ast: ParsedQuery): boolean {
  if (ast.degraded || !canBypassLexicalAdmission(ast) || /\bAND\b/i.test(ast.raw)) return false;
  return ast.groups[0]!.nodes.length >= 3 || /[?¿]/.test(ast.raw);
}

/** Stopwords cannot independently qualify a memory for broad recall. */
export function informativeSearchTokens(tokens: readonly string[]): string[] {
  return tokens.filter(token => !STOPWORDS.has(token));
}

/** Input is always the canonical tokenizer's normalized, safe lexical terms. */
export function buildInformativeAnyMatch(tokens: readonly string[]): string {
  return tokens.map(token => '"' + token + '"').join(' OR ');
}
