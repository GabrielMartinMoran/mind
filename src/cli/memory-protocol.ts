import * as path from 'node:path';

import { loadMarkdownResource } from '../helpers/markdown-resource';
import { renderTemplate } from '../helpers/template-renderer';

type SetupProtocolAgent = 'opencode' | 'claude-code' | 'codex';

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

export function loadCanonicalProtocolBody(): string {
  return loadMarkdownResource(CANONICAL_PROTOCOL_BODY_PATH);
}

function getProtocolContext(agent: SetupProtocolAgent): Record<string, string | boolean> {
  if (agent === 'opencode') {
    return {
      protocolLabel: 'mind',
      useWhenConnected: false,
      connectedAgentLabel: '',
      useBeforeToolsWording: true,
      useCallBeforeSessionWording: false,
      protocolBody: loadCanonicalProtocolBody(),
    };
  }

  if (agent === 'claude-code') {
    return {
      protocolLabel: 'Claude Code',
      useWhenConnected: true,
      connectedAgentLabel: 'Claude Code',
      useBeforeToolsWording: false,
      useCallBeforeSessionWording: true,
      protocolBody: loadCanonicalProtocolBody(),
    };
  }

  return {
    protocolLabel: 'Codex',
    useWhenConnected: true,
    connectedAgentLabel: 'Codex',
    useBeforeToolsWording: false,
    useCallBeforeSessionWording: true,
    protocolBody: loadCanonicalProtocolBody(),
  };
}

export function renderMemoryProtocol(agent: SetupProtocolAgent): string {
  const template = loadMarkdownResource(MEMORY_PROTOCOL_TEMPLATE_PATH);
  return `${renderTemplate(template, getProtocolContext(agent)).trimEnd()}\n`;
}
