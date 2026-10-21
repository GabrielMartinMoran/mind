// Provider credentials for paid OpenCode stages.
//
// The authorized provider key is read at RUNTIME from the user's OpenCode
// `auth.json` and injected into the isolated child environment only. It is
// never persisted, logged, or written into any evidence artifact. The helper
// is provider-generic: the env var name comes from `PROVIDER_CREDENTIAL_ENV`
// (which mirrors the `env` field declared in OpenCode's models cache).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { credentialEnvVarFor, type ModelRef } from '../config';

/** The OpenCode auth store path for a given home directory. */
export function defaultAuthPath(home: string = homedir()): string {
  return join(home, '.local/share/opencode/auth.json');
}

export class MissingCredentialError extends Error {
  constructor(
    public readonly providerID: string,
    public readonly envVar: string,
    public readonly authPath: string
  ) {
    super(
      `no credential for provider '${providerID}': expected '${envVar}' in ${authPath} ` +
        `(or export it in the environment)`
    );
    this.name = 'MissingCredentialError';
  }
}

/**
 * Read a provider's key from an OpenCode `auth.json`. Returns `null` when the
 * file is absent, unreadable, malformed, or has no key for the provider.
 */
export function readProviderKey(authPath: string, providerID: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<
      string,
      { key?: unknown } | undefined
    >;
    const key = parsed[providerID]?.key;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export interface CredentialEnvOptions {
  /** Overrides the auth store path (tests). */
  readonly authPath?: string;
  /** Falls back to this value when the auth store has no key. */
  readonly fallback?: string | undefined;
}

/**
 * Resolve the environment fragment that carries the authorized credential for
 * `model`. Returns `{ [envVar]: key }` only when the provider maps to a known
 * env var; throws `MissingCredentialError` when the provider is known but no
 * key is available, so a paid stage fails closed before sending a prompt.
 */
export function loadCredentialEnv(
  model: ModelRef,
  options: CredentialEnvOptions = {}
): Record<string, string> {
  const envVar = credentialEnvVarFor(model);
  if (!envVar) return {};
  const authPath = options.authPath ?? defaultAuthPath();
  const key = readProviderKey(authPath, model.providerID) ?? options.fallback;
  if (!key) throw new MissingCredentialError(model.providerID, envVar, authPath);
  return { [envVar]: key };
}
