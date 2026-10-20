import type { MindStore } from '../store/mind-store';
import type { Memory } from '../types';

import { SyncCoordinator, type SyncCoordinatorOptions } from './sync-coordinator';

const WRAPPED = Symbol.for('mind.autoExportStore.wrapped');
const TARGET = Symbol.for('mind.autoExportStore.target');
let suppressionDepth = 0;

type WrappedStore = MindStore & { [WRAPPED]?: true; [TARGET]?: MindStore };

export async function runWithAutoExportSuppressed<T>(fn: () => T | Promise<T>): Promise<T> {
  suppressionDepth++;
  try {
    return await fn();
  } finally {
    suppressionDepth--;
  }
}

function isSuppressed(): boolean {
  return suppressionDepth > 0;
}

async function exportAfter<T>(
  coordinator: SyncCoordinator,
  spaces: Array<string | null | undefined>,
  operation: () => T | Promise<T>
): Promise<T> {
  const result = await operation();
  if (!isSuppressed()) await coordinator.autoExportSpaces(spaces);
  return result;
}

function memorySpace(store: MindStore, id: string): string | null {
  return store.getMemoryById(id)?.space_name ?? null;
}

export function withAutoExport(store: MindStore, options: SyncCoordinatorOptions = {}): MindStore {
  const target = (store as WrappedStore)[TARGET] ?? store;
  const coordinator = new SyncCoordinator(target, options);
  const wrapped: WrappedStore = {
    ...target,
    [WRAPPED]: true,
    [TARGET]: target,

    createSpace(name, description, tags) {
      target.createSpace(name, description, tags);
      void coordinator.autoExportSpaces([name]);
    },
    updateSpace(name, updates) {
      target.updateSpace(name, updates);
      void coordinator.autoExportSpaces([name]);
    },
    deleteSpace(name) {
      target.deleteSpace(name);
      void coordinator.autoExportSpaces([name]);
    },
    renameSpace(oldName, newName) {
      target.renameSpace(oldName, newName);
      void coordinator.autoExportSpaces([oldName, newName]);
    },
    addSpaceTag(space, tag) {
      target.addSpaceTag(space, tag);
      void coordinator.autoExportSpaces([space]);
    },
    removeSpaceTag(space, tag) {
      target.removeSpaceTag(space, tag);
      void coordinator.autoExportSpaces([space]);
    },

    async addMemory(space, name, content, opts): Promise<Memory> {
      return exportAfter(coordinator, [space], () => target.addMemory(space, name, content, opts));
    },
    async updateMemory(id, updates) {
      const beforeSpace = memorySpace(target, id);
      await exportAfter(coordinator, [beforeSpace], () => target.updateMemory(id, updates));
    },
    async moveMemory(id, updates) {
      const beforeSpace = memorySpace(target, id);
      return exportAfter(coordinator, [beforeSpace, updates.space], () =>
        target.moveMemory(id, updates)
      );
    },
    deleteMemory(id) {
      const beforeSpace = memorySpace(target, id);
      target.deleteMemory(id);
      void coordinator.autoExportSpaces([beforeSpace]);
    },
    deleteMemoryByName(space, name) {
      target.deleteMemoryByName(space, name);
      void coordinator.autoExportSpaces([space]);
    },
    async completeCheckpoint(input) {
      return exportAfter(coordinator, [input.space], () => target.completeCheckpoint(input));
    },
    async patchMemory(id, patch) {
      const beforeSpace = memorySpace(target, id);
      const result = await exportAfter(coordinator, [beforeSpace], () =>
        target.patchMemory(id, patch)
      );
      return result;
    },
    addMemoryTag(id, tag) {
      const space = memorySpace(target, id);
      target.addMemoryTag(id, tag);
      void coordinator.autoExportSpaces([space]);
    },
    removeMemoryTag(id, tag) {
      const space = memorySpace(target, id);
      target.removeMemoryTag(id, tag);
      void coordinator.autoExportSpaces([space]);
    },
    setMemoryTags(id, tags) {
      const space = memorySpace(target, id);
      target.setMemoryTags(id, tags);
      void coordinator.autoExportSpaces([space]);
    },
    promote(id) {
      const space = memorySpace(target, id);
      target.promote(id);
      void coordinator.autoExportSpaces([space]);
    },
    demote(id) {
      const space = memorySpace(target, id);
      target.demote(id);
      void coordinator.autoExportSpaces([space]);
    },
    pin(id) {
      const space = memorySpace(target, id);
      target.pin(id);
      void coordinator.autoExportSpaces([space]);
    },
    unpin(id) {
      const space = memorySpace(target, id);
      target.unpin(id);
      void coordinator.autoExportSpaces([space]);
    },
    link(sourceId, targetId, label) {
      const sourceSpace = memorySpace(target, sourceId);
      const targetSpace = memorySpace(target, targetId);
      target.link(sourceId, targetId, label);
      void coordinator.autoExportSpaces([sourceSpace, targetSpace]);
    },
    unlink(sourceId, targetId) {
      const sourceSpace = memorySpace(target, sourceId);
      const targetSpace = memorySpace(target, targetId);
      target.unlink(sourceId, targetId);
      void coordinator.autoExportSpaces([sourceSpace, targetSpace]);
    },
  };
  return wrapped;
}
