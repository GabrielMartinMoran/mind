/**
 * Shared checkpoint-to-session transformation logic.
 * Used by both CLI `checkpoint complete` and MCP `checkpoint_done`.
 */

import { fetchCheckpointContent } from '../helpers/checkpoint-content';
import {
  buildOfficialSessionSummaryContent,
  buildSessionSummaryName,
  SESSION_SUMMARY_TAGS,
  SESSION_SUMMARY_TIER,
} from '../helpers/session-summary';
import type { MindStore } from '../store/mind-store';
import { now } from '../store/shared';

export interface CompleteCheckpointResult {
  sessionMemory: {
    space: string;
    name: string;
    tags: string[];
  };
}

/**
 * Transforms a checkpoint into a same-space session memory.
 *
 * - Gets the checkpoint memory and its links
 * - Creates session memory with copied content + summary
 * - Copies inbound and outbound links from checkpoint to session memory
 * - Deletes the original checkpoint
 */
export async function completeCheckpoint(
  store: MindStore,
  space: string,
  checkpointMemoryId: string,
  summary: string
): Promise<CompleteCheckpointResult> {
  // Get full checkpoint memory
  const checkpointMemory = store.getMemoryById(checkpointMemoryId);
  if (!checkpointMemory) {
    throw new Error(`Checkpoint with id ${checkpointMemoryId} could not be loaded.`);
  }

  if (!checkpointMemory.tags.includes('checkpoint')) {
    throw new Error(
      `Memory "${checkpointMemory.name}" in "${space}" is not a checkpoint; refusing to complete it.`
    );
  }

  // Parse checkpoint content
  const checkpointContent = fetchCheckpointContent(checkpointMemory);
  if (!checkpointContent) {
    throw new Error(
      `Checkpoint "${checkpointMemory.name}" has invalid JSON content and cannot be completed.`
    );
  }

  if (checkpointContent.pending.trim().length > 0) {
    throw new Error(
      `Checkpoint "${checkpointMemory.name}" still has pending work: "${checkpointContent.pending}". ` +
        'Update the checkpoint to clear pending work before calling checkpoint_done. ' +
        'If the work is being abandoned, clear pending explicitly and record why in notes.'
    );
  }

  // Get links from the checkpoint (linked_memories are stored as links, not in content)
  const checkpointLinks = store.getLinks(checkpointMemory.id);

  // Create session memory content
  const completedAt = now();
  const sessionContent = buildOfficialSessionSummaryContent({
    writer: 'checkpoint_done',
    base: {
      ...checkpointContent,
      updatedAt: completedAt,
    },
    whatWasDone: summary,
    completedAt,
    originalCheckpoint: checkpointMemory.name,
    provenance: {
      checkpoint: {
        space: checkpointMemory.space_name,
        name: checkpointMemory.name,
      },
    },
  });

  // Create session memory with name "session-{timestamp}"
  // Links will be recreated after creating the session memory
  const sessionMemory = await store.addMemory(
    space,
    buildSessionSummaryName(new Date()),
    sessionContent,
    {
      tags: [...SESSION_SUMMARY_TAGS],
      tier: SESSION_SUMMARY_TIER,
    }
  );

  // Recreate links from and to the checkpoint on the session memory
  for (const link of checkpointLinks) {
    try {
      if (link.source_id === checkpointMemory.id) {
        store.link(sessionMemory.id, link.target_id, link.label || 'related');
      }

      if (link.target_id === checkpointMemory.id) {
        store.link(link.source_id, sessionMemory.id, link.label || 'related');
      }
    } catch {
      // Ignore link errors (best-effort)
    }
  }

  // Delete the original checkpoint (not just mark complete)
  store.deleteMemory(checkpointMemory.id);

  return {
    sessionMemory: {
      space,
      name: sessionMemory.name,
      tags: sessionMemory.tags,
    },
  };
}
