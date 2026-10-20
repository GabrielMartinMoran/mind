import { normalizeTags } from '../../../helpers/tags';
import type { MemoryPatchInput, MindStore } from '../../../store/mind-store';
import { presentMemoryResponse } from '../../helpers/memory-response';
import { buildYamlContent } from '../../helpers/yaml-response';
import { MemoryUpdateSchema } from '../../schemas/memories/update-memory';

export interface TagDiff {
  addTags: string[];
  removeTags: string[];
}

/**
 * Normalizes and dedupes the proposed tag set, then derives the minimal
 * add/remove operations needed to turn `existing` into that set.
 */
export function computeTagDiff(existing: string[], proposed: string[]): TagDiff {
  const normalizedProposed = [...new Set(normalizeTags(proposed))];
  const proposedSet = new Set(normalizedProposed);
  const existingSet = new Set(existing);

  return {
    addTags: normalizedProposed.filter(tag => !existingSet.has(tag)),
    removeTags: existing.filter(tag => !proposedSet.has(tag)),
  };
}

export function updateMemoryHandler(store: MindStore) {
  return async (args: unknown) => {
    const parsed = MemoryUpdateSchema.parse(args ?? {});
    if (!parsed.space || !parsed.name) {
      throw new Error('Both space and name are required.');
    }

    const existing = store.getMemory(parsed.space, parsed.name);
    if (!existing) {
      throw new Error(`Memory "${parsed.name}" not found in space "${parsed.space}".`);
    }

    // Validate and diff tags before opening the single atomic patch.
    const tagDiff =
      parsed.tags !== undefined ? computeTagDiff(existing.tags, parsed.tags) : undefined;

    const patch: MemoryPatchInput = {};
    if (parsed.newName !== undefined) patch.name = parsed.newName;
    if (parsed.content !== undefined) patch.content = parsed.content;
    if (parsed.pinned !== undefined) patch.pinned = parsed.pinned;
    if (parsed.tierTransition !== undefined) patch.tierTransition = parsed.tierTransition;
    if (tagDiff && tagDiff.addTags.length > 0) patch.addTags = tagDiff.addTags;
    if (tagDiff && tagDiff.removeTags.length > 0) patch.removeTags = tagDiff.removeTags;

    const hasOperation = Object.keys(patch).length > 0;
    if (!hasOperation) {
      return buildYamlContent({ memory: presentMemoryResponse(existing) });
    }

    const memory = await store.patchMemory(existing.id, patch);
    return buildYamlContent({ memory: presentMemoryResponse(memory) });
  };
}
