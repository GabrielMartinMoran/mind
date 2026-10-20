import * as path from 'node:path';

import { loadMarkdownResource } from '../helpers/markdown-resource';
import { renderTemplate } from '../helpers/template-renderer';

import { loadCanonicalProtocolBody } from './memory-protocol';

const SKILL_TEMPLATE_PATH = path.resolve(__dirname, '..', 'resources', 'skill-mind-management.md');

export function renderMindManagementSkill(): string {
  const template = loadMarkdownResource(SKILL_TEMPLATE_PATH);
  return `${renderTemplate(template, { protocolBody: loadCanonicalProtocolBody() }).trimEnd()}\n`;
}
