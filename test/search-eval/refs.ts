// ── Canonical memory references used by the eval suite ──

/**
 * A memory ref is the stable identity of a memory within a space:
 * `"<space>::<name>"`. Names never contain `::`, and spaces keep their slashes,
 * so the `::` separator is unambiguous.
 */
export function refOf(spaceName: string, memoryName: string): string {
  return `${spaceName}::${memoryName}`;
}

export function parseRef(ref: string): { space: string; name: string } {
  const index = ref.indexOf('::');
  if (index === -1) return { space: '', name: ref };
  return { space: ref.slice(0, index), name: ref.slice(index + 2) };
}

/** Deduplicate refs while preserving first-seen order. */
export function dedupeRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/** Sort refs with a stable comparator so snapshots are deterministic. */
export function sortRefs(refs: string[]): string[] {
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
