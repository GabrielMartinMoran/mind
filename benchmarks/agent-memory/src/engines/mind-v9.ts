// Mind v9 engine adapter (`main@36d2f1e`, schema 8).
//
// Thin constructor over the shared `createMindEngine` implementation, pinned to
// version `v9` (its `/api/search` items carry `rank`, no pagination).

import { createMindEngine, type MindEngineAdapter, type MindEngineOptions } from './mind-engine';

export type { MindEngineAdapter, MindEngineOptions } from './mind-engine';

export function createMindV9Engine(options: MindEngineOptions): MindEngineAdapter {
  return createMindEngine('v9', options);
}
