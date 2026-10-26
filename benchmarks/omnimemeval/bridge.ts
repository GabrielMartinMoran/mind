/**
 * Local transport adapter for OmniMemEval. Calls Mind's production store API:
 * one durable memory per benchmark conversation session, RAG disabled.
 * This does not modify Mind's ranking, prompts or admission policy.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  EmptySearchQueryError,
  EMPTY_SEARCH_QUERY_MESSAGE,
} from '../../src/store/shared/search-query-error';

const port = 40315;

export interface BridgeErrorResponse {
  status: number;
  body: { error: string };
}

/**
 * Maps a bridge operation failure to its HTTP response. A caller-supplied
 * empty/all-stopword query is a validation error (400); every other failure
 * stays a generic 500 so unrelated defects are never masked as client errors.
 */
export function mapBridgeError(error: unknown): BridgeErrorResponse {
  if (error instanceof EmptySearchQueryError) {
    return { status: 400, body: { error: EMPTY_SEARCH_QUERY_MESSAGE } };
  }
  return { status: 500, body: { error: String(error) } };
}

export async function startBridge(): Promise<void> {
  process.env.MIND_RAG = 'false';
  const { createSqliteStore } = await import('../../src/store/sqlite-store.ts');

  const store = createSqliteStore(join(tmpdir(), 'mind-omnimemeval-' + process.pid + '.sqlite'));
  const counts = new Map<string, number>();

  function userSpace(userId: unknown): string {
    if (typeof userId !== 'string' || !/^lme_exper_user_[a-zA-Z0-9_-]+$/.test(userId)) {
      throw new Error('Invalid benchmark user');
    }
    return userId;
  }

  async function add(payload: any) {
    const space = userSpace(payload.user_id);
    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Empty messages');
    if (!store.getSpace(space))
      store.createSpace(space, 'Isolated LongMemEval user', ['benchmark']);
    const index = (counts.get(space) ?? 0) + 1;
    counts.set(space, index);
    const sessionTime = messages[0]?.chat_time ?? 'unknown time';
    const content =
      '[Session timestamp: ' +
      sessionTime +
      ']\n' +
      messages
        .map(
          (message: any) => String(message.role ?? 'unknown') + ': ' + String(message.content ?? '')
        )
        .join('\n');
    await store.addMemory(space, 'session-' + String(index).padStart(3, '0'), content, {
      tags: ['benchmark', 'session'],
      tier: 3,
    });
    return { ok: true, count: index };
  }

  async function search(payload: any) {
    const space = userSpace(payload.user_id);
    if (!store.getSpace(space)) return { memories: '', count: 0 };
    const limit = Number(payload.top_k ?? 20);
    const results = await store.search(String(payload.query ?? ''), {
      space,
      limit: Math.max(1, Math.min(20, limit)),
      semantic: false,
    });
    return {
      count: results.length,
      memories: results
        .map(
          (result, index) => '[Memory ' + (index + 1) + ' | ' + result.name + ']\n' + result.content
        )
        .join('\n\n'),
    };
  }

  function clear(payload: any) {
    const space = userSpace(payload.user_id);
    if (store.getSpace(space)) store.deleteSpace(space);
    counts.delete(space);
    return { ok: true };
  }

  Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      if (new URL(request.url).pathname === '/health') {
        return Response.json({ ok: true, engine: 'mind', rag: false });
      }
      try {
        const payload = (await request.json()) as any;
        const pathname = new URL(request.url).pathname;
        const result =
          pathname === '/add'
            ? await add(payload)
            : pathname === '/search'
              ? await search(payload)
              : pathname === '/delete'
                ? clear(payload)
                : null;
        if (!result) return Response.json({ error: 'Unknown operation' }, { status: 404 });
        return Response.json(result);
      } catch (error) {
        console.error('mind-omnimemeval operation failed:', error);
        const mapped = mapBridgeError(error);
        return Response.json(mapped.body, { status: mapped.status });
      }
    },
  });
  console.log('Mind OmniMemEval bridge listening on 127.0.0.1:' + port);
}

if (import.meta.main) await startBridge();
