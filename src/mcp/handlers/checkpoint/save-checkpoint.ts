import { saveCheckpoint } from '../../../checkpoint/checkpoint-save';
import type { MindStore } from '../../../store/mind-store';
import { buildYamlContent } from '../../helpers/yaml-response';
import { CheckpointSaveSchema } from '../../schemas/checkpoint/save-checkpoint';

export function saveCheckpointHandler(store: MindStore) {
  return async (args: unknown) => {
    const parsed = CheckpointSaveSchema.parse(args ?? {});

    if (!parsed.space) {
      throw new Error('Space is required.');
    }

    const space = parsed.space;

    if (!store.getSpace(space)) {
      throw new Error(`Space "${space}" not found.`);
    }

    const result = await saveCheckpoint(store, space, {
      goal: parsed.goal,
      pending: parsed.pending,
      notes: parsed.notes,
      linkedMemories: parsed.linked_memories,
    });

    return buildYamlContent({
      checkpoint: {
        space,
        name: result.checkpoint.name,
        tier: result.checkpoint.tier,
        tags: result.checkpoint.tags,
      },
      created: result.created,
      links_created: result.links_created,
      links_failed: result.links_failed,
    });
  };
}
