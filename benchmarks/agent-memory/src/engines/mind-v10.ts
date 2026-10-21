// Mind v10 engine adapter (`develop@c7029b3`, schema 10).
//
// Thin constructor over the shared `createMindEngine` implementation, pinned to
// version `v10` (its `/api/search` items carry `score`/`confidence`/`methods`
// and accept a `limit` parameter).

import { createMindEngine, type MindEngineAdapter, type MindEngineOptions } from './mind-engine';

export type { MindEngineAdapter, MindEngineOptions } from './mind-engine';

export function createMindV10Engine(options: MindEngineOptions): MindEngineAdapter {
  return createMindEngine('v10', options);
}
