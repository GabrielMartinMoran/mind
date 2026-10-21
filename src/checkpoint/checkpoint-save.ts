// ── Shared checkpoint save/update logic ──
// Used by both MCP `checkpoint_save` and CLI `checkpoint set`.

import {
  buildCheckpointContent,
  fetchCheckpointContent,
  type CheckpointContent,
} from '../helpers/checkpoint-content';
import { resolveRefWithFallback } from '../helpers/memory-ref-resolver';
import type { MindStore } from '../store/mind-store';
import type { Memory, Tier } from '../types';

import { findActiveCheckpoint } from './checkpoint-lookup';

export interface SaveCheckpointInput {
  goal?: string;
  pending?: string;
  notes?: string;
  linkedMemories?: string[];
}

export interface CheckpointLinkFailure {
  ref: string;
  reason: string;
}

export interface CheckpointLinkCreated {
  source: string;
  target: string;
  label: string;
}

export interface SaveCheckpointResult {
  checkpoint: Memory;
  created: boolean;
  links_created: CheckpointLinkCreated[];
  links_failed: CheckpointLinkFailure[];
}

function buildCheckpointName(date = new Date()): string {
  return `checkpoint-${date.toISOString().replace(/[:.]/g, '-')}`;
}

function resolveFields(
  input: SaveCheckpointInput,
  current?: CheckpointContent
): { goal: string; pending: string; notes: string; changed: boolean } {
  const goal = input.goal ?? current?.goal ?? '';
  const pending = input.pending ?? current?.pending ?? '';
  const notes = input.notes ?? current?.notes ?? '';

  const changed =
    (input.goal !== undefined && input.goal !== (current?.goal ?? '')) ||
    (input.pending !== undefined && input.pending !== (current?.pending ?? '')) ||
    (input.notes !== undefined && input.notes !== (current?.notes ?? ''));

  return { goal, pending, notes, changed };
}

async function resolveLinks(store: MindStore, space: string, refs: string[]) {
  const resolved: Array<{ ref: string; id: string; name: string }> = [];
  const failed: CheckpointLinkFailure[] = [];

  for (const ref of refs) {
    try {
      const memory = resolveRefWithFallback(store, ref, space);
      resolved.push({ ref, id: memory.id, name: memory.name });
    } catch (error) {
      failed.push({
        ref,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  return { resolved, failed };
}

/**
 * Create or update the active checkpoint.
 *
 * Omitted fields keep their current value, `""` clears a field deliberately,
 * and a call with no effective change leaves the checkpoint untouched.
 */
export async function saveCheckpoint(
  store: MindStore,
  space: string,
  input: SaveCheckpointInput
): Promise<SaveCheckpointResult> {
  const active = await findActiveCheckpoint(store, space);
  const refs = input.linkedMemories ?? [];

  if (!active) {
    const { goal, pending, notes } = resolveFields(input);
    const { resolved, failed } = await resolveLinks(store, space, refs);
    const name = buildCheckpointName();
    const checkpoint = await store.addMemory(
      space,
      name,
      buildCheckpointContent(goal, pending, notes),
      {
        tags: ['checkpoint', 'active'],
        tier: 1 as Tier,
        linksToIds: resolved.map(link => link.id),
      }
    );

    return {
      checkpoint,
      created: true,
      links_created: resolved.map(link => ({
        source: name,
        target: link.name,
        label: 'related',
      })),
      links_failed: failed,
    };
  }

  const existing = store.getMemoryById(active.id);
  if (!existing) {
    throw new Error(`Active checkpoint "${active.name}" could not be loaded.`);
  }

  const currentContent = fetchCheckpointContent(existing);
  if (!currentContent) {
    throw new Error(
      `Checkpoint "${existing.name}" has invalid JSON content and cannot be updated. ` +
        'Repair or remove it before saving again.'
    );
  }

  const { goal, pending, notes, changed } = resolveFields(input, currentContent);
  const { resolved, failed } = await resolveLinks(store, space, refs);

  const alreadyLinked = new Set(
    store
      .getLinks(existing.id)
      .filter(link => link.source_id === existing.id)
      .map(link => link.target_id)
  );

  const newLinks = resolved.filter(link => link.id !== existing.id && !alreadyLinked.has(link.id));

  const patch: { content?: string; addLinksToIds?: string[] } = {};
  if (changed) {
    patch.content = buildCheckpointContent(goal, pending, notes, currentContent.createdAt);
  }
  if (newLinks.length > 0) {
    patch.addLinksToIds = newLinks.map(link => link.id);
  }

  const checkpoint =
    patch.content !== undefined || patch.addLinksToIds !== undefined
      ? await store.patchMemory(existing.id, patch)
      : existing;

  return {
    checkpoint,
    created: false,
    links_created: newLinks.map(link => ({
      source: existing.name,
      target: link.name,
      label: 'related',
    })),
    links_failed: failed,
  };
}
