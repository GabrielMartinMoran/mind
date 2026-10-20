// Deterministic LoCoMo ingestion, identical for v9 and v10.
//
// One memory per dialogue turn, written through the pinned engine's own CLI:
//   name    = `dia_id` (stable, matches the QA evidence list)
//   content = `[<session date_time>] <speaker>: <text>` (+ `\n[Photo: ...]`)
//   tags    = [`locomo`, `session:<n>`]
//   tier    = 3 (cold, unlimited capacity => no eviction, no discarded turns)
//
// After ingestion the stored memory set is verified against the exact `dia_id`
// set: same count, no duplicates, no missing / unexpected names. Any mismatch
// fails loudly.

import type { EngineInsertMeta } from '../engines/adapter';
import type { MindEngineAdapter } from '../engines/mind-engine';
import type { MemorySetVerification } from '../mind/inspect';

import {
  findSample,
  sessionDateTime,
  sessionNumbers,
  sessionTurns,
  type LocomoDataset,
} from './types';

export class LocomoIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocomoIngestError';
  }
}

export interface TurnRecord {
  readonly diaId: string;
  readonly session: number;
  readonly speaker: string;
  readonly text: string;
  readonly sessionDateTime: string;
  readonly blipCaption?: string;
  readonly content: string;
  readonly tags: readonly string[];
}

/** Build the exact memory content for a turn. */
export function buildTurnContent(
  sessionDateTime: string,
  speaker: string,
  text: string,
  blipCaption?: string
): string {
  const head = `[${sessionDateTime}] ${speaker}: ${text}`;
  return blipCaption ? `${head}\n[Photo: ${blipCaption}]` : head;
}

/** Flatten a conversation into ordered turn records (session then turn order). */
export function conversationTurns(dataset: LocomoDataset, conversation: string): TurnRecord[] {
  const sample = findSample(dataset, conversation);
  if (!sample) throw new LocomoIngestError(`conversation '${conversation}' not found`);

  const turns: TurnRecord[] = [];
  for (const session of sessionNumbers(sample.conversation)) {
    const dateTime = sessionDateTime(sample.conversation, session);
    for (const turn of sessionTurns(sample.conversation, session)) {
      turns.push({
        diaId: turn.dia_id,
        session,
        speaker: turn.speaker,
        text: turn.text,
        sessionDateTime: dateTime,
        ...(turn.blip_caption ? { blipCaption: turn.blip_caption } : {}),
        content: buildTurnContent(dateTime, turn.speaker, turn.text, turn.blip_caption),
        tags: ['locomo', `session:${session}`],
      });
    }
  }
  return turns;
}

/** Narrow engine surface required by ingestion (keeps the runner testable). */
export type IngestEngine = Pick<MindEngineAdapter, 'space' | 'reset' | 'insert' | 'ingestDone'>;

export interface IngestConversationOptions {
  readonly conversation: string;
}

export interface IngestResult {
  readonly conversation: string;
  readonly space: string;
  readonly sessions: number;
  readonly turns: number;
  readonly ingestMs: number;
  readonly msPerTurn: number;
  readonly verification: MemorySetVerification;
}

export async function ingestConversation(
  engine: IngestEngine,
  dataset: LocomoDataset,
  options: IngestConversationOptions
): Promise<IngestResult> {
  const sample = findSample(dataset, options.conversation);
  if (!sample) throw new LocomoIngestError(`conversation '${options.conversation}' not found`);

  const turns = conversationTurns(dataset, options.conversation);
  const sessions = sessionNumbers(sample.conversation).length;

  await engine.reset(engine.space);
  const started = performance.now();
  for (const turn of turns) {
    const meta: EngineInsertMeta = {
      speaker: turn.speaker,
      session: turn.session,
      timestamp: turn.sessionDateTime,
      diaId: turn.diaId,
      tags: turn.tags,
    };
    await engine.insert(engine.space, turn.content, meta);
  }
  const ingestMs = performance.now() - started;

  const verification = await engine.ingestDone(turns.map(turn => turn.diaId));
  if (!verification.ok) {
    throw new LocomoIngestError(
      `ingestion verification failed for '${options.conversation}': ${verification.detail}`
    );
  }

  return {
    conversation: options.conversation,
    space: engine.space,
    sessions,
    turns: turns.length,
    ingestMs,
    msPerTurn: turns.length > 0 ? ingestMs / turns.length : 0,
    verification,
  };
}
