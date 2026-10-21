// Credential redaction for any artifact written to disk.
//
// The benchmark injects the authorized provider key into the isolated child
// environment only. Any environment dump that is persisted (job files, raw A2
// results, evidence) MUST run through `redactEnv` first so a key can never be
// written to an artifact, even transiently.

/** Placeholder written in place of a credential-bearing value. */
export const REDACTED = '[redacted]';

const SECRET_KEY = /key|token|secret|password|credential/i;

/** Return a copy of an env map with secret-looking values replaced. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Drop redaction placeholders from an env map. A worker applies this to the
 * (redacted) `job.json` env so a placeholder can never overwrite the real
 * credential the parent injected into the process environment.
 */
export function stripRedacted(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === REDACTED) continue;
    out[key] = value;
  }
  return out;
}
