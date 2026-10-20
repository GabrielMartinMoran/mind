import { describe, expect, test } from 'bun:test';

import { renderTemplate } from '../src/helpers/template-renderer';

describe('template renderer strict mode', () => {
  test('renders placeholders and conditionals when all keys are resolved', () => {
    const output = renderTemplate('Hello {{name}} {{#if excited}}!{{/if}}', {
      name: 'mind',
      excited: true,
    });

    expect(output).toBe('Hello mind !');
  });

  test('renders a composed protocolBody placeholder', () => {
    const output = renderTemplate('# Wrapper\n\n{{protocolBody}}', {
      protocolBody: '## Body\n\nContent.',
    });

    expect(output).toBe('# Wrapper\n\n## Body\n\nContent.');
  });

  test('throws when a placeholder key is missing', () => {
    expect(() => renderTemplate('Hello {{name}}', {})).toThrow(/name/);
  });

  test('throws when a placeholder resolves to nullish value', () => {
    expect(() => renderTemplate('Hello {{name}}', { name: undefined })).toThrow(/name/);
  });

  test('throws when a conditional key is missing', () => {
    expect(() => renderTemplate('{{#if enabled}}ok{{/if}}', {})).toThrow(/enabled/);
  });

  test('throws when template contains unresolved tokens after rendering', () => {
    expect(() => renderTemplate('Hello {{#if feature}}world', { feature: true })).toThrow(
      /unresolved/i
    );
  });
});
