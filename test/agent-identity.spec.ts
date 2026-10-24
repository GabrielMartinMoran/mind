import { describe, expect, test } from 'bun:test';

import {
  normalizeAgentName,
  resolveAgentIdentity,
  type AgentIdentityInput,
} from '../src/helpers/agent-identity';

function resolve(overrides: Partial<AgentIdentityInput>) {
  return resolveAgentIdentity({ transport: 'stdio', ...overrides });
}

describe('normalizeAgentName', () => {
  test.each([
    ['claude', 'claude-code'],
    ['Claude Code', 'claude-code'],
    ['  CLAUDE   CODE  ', 'claude-code'],
    ['claude-code', 'claude-code'],
    ['codex-mcp-client', 'codex'],
    ['codex', 'codex'],
    ['github-copilot', 'vscode'],
    ['GitHub Copilot', 'vscode'],
    ['copilot', 'vscode'],
    ['vs-code', 'vscode'],
    ['vscode', 'vscode'],
    ['windsurf', 'windsurf'],
    ['devin', 'windsurf'],
    ['windsurf/devin', 'windsurf'],
    ['gemini', 'gemini-cli'],
    ['gemini-cli', 'gemini-cli'],
    ['pi-agent', 'pi'],
    ['pi', 'pi'],
    ['opencode', 'opencode'],
    ['cursor', 'cursor'],
    ['antigravity', 'antigravity'],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeAgentName(raw)).toBe(expected);
  });

  test('keeps unknown non-empty names visible in lower case', () => {
    expect(normalizeAgentName('My Custom Agent')).toBe('my-custom-agent');
  });

  test('bounds unknown names to 64 characters', () => {
    const name = normalizeAgentName('a'.repeat(120));

    expect(name).toHaveLength(64);
  });

  test('returns null for missing or blank names', () => {
    expect(normalizeAgentName(undefined)).toBeNull();
    expect(normalizeAgentName(null)).toBeNull();
    expect(normalizeAgentName('')).toBeNull();
    expect(normalizeAgentName('   ')).toBeNull();
  });
});

describe('resolveAgentIdentity', () => {
  test('stdio prefers the environment signal', () => {
    const identity = resolve({
      envAgent: 'opencode',
      clientName: 'mystery-client',
      transport: 'stdio',
    });

    expect(identity.agent).toBe('opencode');
    expect(identity.agentSource).toBe('env');
    expect(identity.transport).toBe('stdio');
  });

  test('stdio falls back to clientInfo', () => {
    const identity = resolve({
      clientName: 'claude-code',
      clientVersion: '2.0.0',
      transport: 'stdio',
    });

    expect(identity.agent).toBe('claude-code');
    expect(identity.agentSource).toBe('client');
    expect(identity.clientName).toBe('claude-code');
    expect(identity.clientVersion).toBe('2.0.0');
  });

  test('http prefers clientInfo over an inherited environment', () => {
    const identity = resolve({
      envAgent: 'codex',
      clientName: 'opencode',
      clientVersion: '9.9.9',
      transport: 'http',
      sessionId: 'session-123',
    });

    expect(identity.agent).toBe('opencode');
    expect(identity.agentSource).toBe('client');
    expect(identity.transport).toBe('http');
    expect(identity.mcpSession).toBe('session-123');
  });

  test('http falls back to the environment when clientInfo is absent', () => {
    const identity = resolve({ envAgent: 'codex', transport: 'http' });

    expect(identity.agent).toBe('codex');
    expect(identity.agentSource).toBe('env');
  });

  test('reports unknown when neither signal is present', () => {
    const identity = resolve({ transport: 'stdio' });

    expect(identity.agent).toBe('unknown');
    expect(identity.agentSource).toBe('unknown');
    expect(identity.clientName).toBeNull();
    expect(identity.clientVersion).toBeNull();
    expect(identity.mcpSession).toBeNull();
  });

  test('preserves raw client name and version without normalizing them', () => {
    const identity = resolve({
      clientName: '  Claude Code  ',
      clientVersion: '2.0.0-beta.1',
      transport: 'stdio',
    });

    expect(identity.clientName).toBe('  Claude Code  ');
    expect(identity.clientVersion).toBe('2.0.0-beta.1');
    expect(identity.agent).toBe('claude-code');
  });

  test('maps a missing session id to null', () => {
    expect(resolve({ envAgent: 'opencode' }).mcpSession).toBeNull();
  });
});
