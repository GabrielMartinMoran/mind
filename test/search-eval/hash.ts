// ── Deterministic hashing helpers for eval snapshots ──

/**
 * Deterministically serialize a value: object keys are sorted recursively so
 * that two structurally identical values always produce the same string,
 * independent of insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex digest of the stable serialization of a value. */
export function stableHash(value: unknown): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(stableStringify(value));
  return hasher.digest('hex');
}
