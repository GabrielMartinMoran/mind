import * as path from 'node:path';

import { loadMarkdownResource } from '../helpers/markdown-resource';
import { renderTemplate } from '../helpers/template-renderer';

import { loadCanonicalProtocolBody } from './memory-protocol';

const SYSTEM_INSTRUCTIONS_TEMPLATE_PATH = path.resolve(
  __dirname,
  '..',
  'resources',
  'protocols',
  'mind-system-instructions.md'
);

export function renderSystemInstructions(): string {
  const template = loadMarkdownResource(SYSTEM_INSTRUCTIONS_TEMPLATE_PATH);
  return `${renderTemplate(template, { protocolBody: loadCanonicalProtocolBody() }).trimEnd()}\n`;
}
