import { completeCheckpoint } from '../../../checkpoint/checkpoint-done';
import { findActiveCheckpoint } from '../../../checkpoint/checkpoint-lookup';
import type { MindStore } from '../../../store/mind-store';
import type { Memory } from '../../../types';
import { buildYamlContent } from '../../helpers/yaml-response';
import { CheckpointDoneSchema } from '../../schemas/checkpoint/done-checkpoint';

export function doneCheckpointHandler(store: MindStore) {
  return async (args: unknown) => {
    const parsed = CheckpointDoneSchema.parse(args ?? {});

    if (!parsed.space) {
      throw new Error('Space is required.');
    }

    const space = parsed.space;

    let checkpointMemory: Memory | null;
    if (parsed.checkpointName) {
      checkpointMemory = store.getMemory(space, parsed.checkpointName);
      if (!checkpointMemory) {
        throw new Error(`Checkpoint "${parsed.checkpointName}" not found in "${space}".`);
      }
    } else {
      const active = await findActiveCheckpoint(store, space);
      if (!active) {
        throw new Error(`No active checkpoint found in "${space}".`);
      }
      checkpointMemory = store.getMemoryById(active.id);
      if (!checkpointMemory) {
        throw new Error('Active checkpoint could not be loaded.');
      }
    }

    const result = await completeCheckpoint(
      store,
      space,
      checkpointMemory.id,
      parsed.summary ?? ''
    );

    return buildYamlContent({
      session_memory: result.sessionMemory,
    });
  };
}
