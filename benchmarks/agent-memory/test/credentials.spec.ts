// Unit tests for the provider-generic credential helper: it reads the key from
// an OpenCode `auth.json` at runtime, maps each provider to its declared env
// var, and never returns anything for an unknown provider.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { MODEL_OPENCODE_GO, MODEL_OPENROUTER, credentialEnvVarFor } from '../src/config';
import {
  MissingCredentialError,
  defaultAuthPath,
  loadCredentialEnv,
  readProviderKey,
} from '../src/opencode/credentials';

function authFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-auth-'));
  const path = join(dir, 'auth.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return path;
}

describe('credentialEnvVarFor', () => {
  test('maps openrouter and opencode-go to their declared env vars', () => {
    expect(credentialEnvVarFor(MODEL_OPENROUTER)).toBe('OPENROUTER_API_KEY');
    expect(credentialEnvVarFor(MODEL_OPENCODE_GO)).toBe('OPENCODE_API_KEY');
  });

  test('returns null for an unknown provider', () => {
    expect(credentialEnvVarFor({ providerID: 'mystery', id: 'x' })).toBeNull();
  });
});

describe('defaultAuthPath', () => {
  test('points at the OpenCode auth store under the given home', () => {
    expect(defaultAuthPath('/home/user')).toBe('/home/user/.local/share/opencode/auth.json');
  });
});

describe('readProviderKey', () => {
  test('reads the key for the requested provider entry', () => {
    const path = authFile({ openrouter: { type: 'api', key: 'or-secret' } });
    expect(readProviderKey(path, 'openrouter')).toBe('or-secret');
  });

  test('returns null for a missing provider, missing file, or malformed JSON', () => {
    expect(readProviderKey(authFile({ openai: { key: 'x' } }), 'openrouter')).toBeNull();
    expect(readProviderKey('/no/such/auth.json', 'openrouter')).toBeNull();
    expect(readProviderKey(authFile('{not json'), 'openrouter')).toBeNull();
  });
});

describe('loadCredentialEnv', () => {
  test('selects OPENROUTER_API_KEY for the openrouter provider only', () => {
    const authPath = authFile({
      openrouter: { key: 'or-secret' },
      'opencode-go': { key: 'oc-secret' },
    });
    const env = loadCredentialEnv(MODEL_OPENROUTER, { authPath });
    expect(env).toEqual({ OPENROUTER_API_KEY: 'or-secret' });
    expect(env.OPENCODE_API_KEY).toBeUndefined();
  });

  test('selects OPENCODE_API_KEY for the opencode-go provider only', () => {
    const authPath = authFile({
      openrouter: { key: 'or-secret' },
      'opencode-go': { key: 'oc-secret' },
    });
    expect(loadCredentialEnv(MODEL_OPENCODE_GO, { authPath })).toEqual({
      OPENCODE_API_KEY: 'oc-secret',
    });
  });

  test('returns {} for a provider without a declared env var', () => {
    expect(loadCredentialEnv({ providerID: 'mystery', id: 'x' })).toEqual({});
  });

  test('fails closed when the provider is known but no key is available', () => {
    const authPath = authFile({ openai: { key: 'x' } });
    expect(() => loadCredentialEnv(MODEL_OPENROUTER, { authPath })).toThrow(MissingCredentialError);
  });

  test('accepts an explicit fallback (environment export) instead of the store', () => {
    expect(
      loadCredentialEnv(MODEL_OPENROUTER, { authPath: '/nope', fallback: 'from-env' })
    ).toEqual({
      OPENROUTER_API_KEY: 'from-env',
    });
  });
});
