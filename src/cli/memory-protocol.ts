import * as path from 'node:path';

import { loadMarkdownResource } from '../helpers/markdown-resource';
import { renderTemplate } from '../helpers/template-renderer';

import { renderSkillActivation } from './skill-activation';

type SetupProtocolAgent = 'opencode' | 'claude-code' | 'codex' | 'pi';

const MEMORY_PROTOCOL_TEMPLATE_PATH = path.resolve(
  __dirname,
  '..',
  'resources',
  'protocols',
  'mind-memory-protocol.template.md'
);

const CANONICAL_PROTOCOL_BODY_PATH = path.resolve(
  __dirname,
  '..',
  'resources',
  'protocols',
  'mind-cognitive-protocol.md'
);

const AGENT_PROTOCOL_LABELS: Record<SetupProtocolAgent, string> = {
  opencode: 'mind',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi Agent',
};

export function loadCanonicalProtocolBody(): string {
  return loadMarkdownResource(CANONICAL_PROTOCOL_BODY_PATH);
}

function getProtocolContext(agent: SetupProtocolAgent): Record<string, string> {
  return {
    protocolLabel: AGENT_PROTOCOL_LABELS[agent],
    activation: renderSkillActivation(),
  };
}

export function renderMemoryProtocol(agent: SetupProtocolAgent): string {
  const template = loadMarkdownResource(MEMORY_PROTOCOL_TEMPLATE_PATH);
  return `${renderTemplate(template, getProtocolContext(agent)).trimEnd()}\n`;
}
