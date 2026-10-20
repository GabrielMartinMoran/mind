// Shared benchmark-B assertion helpers (pure, no I/O).

export interface NamedMemory {
  readonly space: string;
  readonly name: string;
}

/**
 * Names stored more than once within the same space. Memory names are unique per
 * space, so any duplicate indicates an atomic-write failure.
 */
export function duplicateMemoryNames(memories: readonly NamedMemory[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const key = `${memory.space}\u0000${memory.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key.split('\u0000')[1]!);
}
