import type { MindStore } from '../../../store/mind-store';
import {
  applyCheckpointSortAndPagination,
  fetchAllCheckpointMemories,
  fetchCheckpointSummaries,
} from '../../helpers/checkpoint-query';
import { presentSpaceResponse } from '../../helpers/memory-response';
import { buildReferencesBlock, buildTrendingTierBlock } from '../../helpers/space-orientation';
import { buildYamlContent } from '../../helpers/yaml-response';
import { SpaceGetSchema } from '../../schemas/spaces/get-space';

const TRENDING_PREVIEW_LIMIT = 5;
const REFERENCES_PREVIEW_LIMIT = 5;

export function getSpaceHandler(store: MindStore) {
  return async (args: unknown) => {
    const parsed = SpaceGetSchema.parse(args ?? {});
    if (!parsed.name) {
      throw new Error('Space name is required.');
    }

    const space = store.getSpace(parsed.name);
    if (!space) {
      throw new Error(`Space "${parsed.name}" does not exist.`);
    }

    const [tier1, tier2, tier3, references, checkpointMemories] = await Promise.all([
      buildTrendingTierBlock(store, parsed.name, 1, TRENDING_PREVIEW_LIMIT),
      buildTrendingTierBlock(store, parsed.name, 2, TRENDING_PREVIEW_LIMIT),
      buildTrendingTierBlock(store, parsed.name, 3, TRENDING_PREVIEW_LIMIT),
      buildReferencesBlock(store, parsed.name, REFERENCES_PREVIEW_LIMIT),
      fetchAllCheckpointMemories(store, parsed.name),
    ]);

    const activeCheckpointMemories = checkpointMemories.filter(memory =>
      memory.tags.includes('active')
    );
    const { items: sortedActiveCheckpoints, total: activeCheckpointTotal } =
      applyCheckpointSortAndPagination(
        activeCheckpointMemories,
        0,
        Math.max(activeCheckpointMemories.length, 1)
      );
    const activeCheckpoints = await fetchCheckpointSummaries(store, sortedActiveCheckpoints);

    const status = store.getStatus(parsed.name);

    return buildYamlContent({
      space: presentSpaceResponse(space),
      overview: {
        total_memories: status.total_memories,
        active_checkpoints: activeCheckpointTotal,
        by_tier: status.by_tier,
      },
      trending_memories: {
        tier_1: tier1,
        tier_2: tier2,
        tier_3: tier3,
      },
      references,
      active_checkpoints: {
        total: activeCheckpointTotal,
        checkpoints: activeCheckpoints,
      },
    });
  };
}
