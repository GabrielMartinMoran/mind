import { normalizeTag, normalizeTags } from '../../helpers/tags';
import { presentMemoryDetail } from '../presenters/memory';

import { resolveTierFilter, parseTier } from './query-filters';
import type { RouteDefinition } from './types';
import { regex } from './types';

function parseIntParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return n;
}

export const memoryRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    match: regex(/^\/api\/spaces\/([^/]+)\/graph$/, ['space']),
    handle: ({ params, url, store, json }) => {
      const rawLimit = parseIntParam(url.searchParams.get('limit'));
      const graph = store.getSpaceGraph(params.space!, { limit: rawLimit, maxLimit: 1000 });
      return json(graph);
    },
  },
  {
    method: 'GET',
    match: regex(/^\/api\/memories\/query$/, []),
    handle: async ({ url, store }) => {
      const tierFilter = resolveTierFilter(url.searchParams);
      const tagRaw = url.searchParams.get('tag');
      const tag = tagRaw ? normalizeTag(tagRaw) : undefined;

      const filters = {
        space: url.searchParams.get('space') ?? undefined,
        tag,
        ...tierFilter,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      };

      const memories = store.queryMemories({
        ...filters,
        limit: parseIntParam(url.searchParams.get('limit')),
        offset: parseIntParam(url.searchParams.get('offset')),
      });
      const total = await store.queryMemoriesCount(filters);

      // Flat array body plus an additive total header, matching /api/search.
      return Response.json(memories, {
        headers: { 'X-Total-Count': String(total) },
      });
    },
  },
  {
    method: 'GET',
    match: regex(/^\/api\/spaces\/([^/]+)\/memories$/, ['space']),
    handle: ({ params, url, store, json }) => {
      const space = params.space!;
      const tier = parseTier(url.searchParams.get('tier'));
      const tagRaw = url.searchParams.get('tag');
      const tag = tagRaw ? normalizeTag(tagRaw) : undefined;

      if (tier !== undefined) {
        return json(store.listMemories(space, { tier, tag }));
      }

      const t1 = store.listMemories(space, { tier: 1, tag });
      const t2 = store.listMemories(space, { tier: 2, tag });
      const t3 = store.listMemories(space, { tier: 3, tag });
      return json([...t1, ...t2, ...t3]);
    },
  },
  {
    method: 'POST',
    match: regex(/^\/api\/spaces\/([^/]+)\/memories$/, ['space']),
    handle: async ({ params, req, store, json, err }) => {
      const space = params.space!;
      const body = (await req.json()) as {
        name: string;
        content: string;
        tags?: string[];
        tier?: 1 | 2 | 3;
      };

      if (body.tier !== undefined && (body.tier < 1 || body.tier > 3)) {
        return err('tier must be 1, 2, or 3.', 400);
      }

      const tags = body.tags ? normalizeTags(body.tags) : undefined;
      const memory = await store.addMemory(space, body.name, body.content, {
        tags,
        tier: body.tier,
      });
      return json(memory, 201);
    },
  },
  {
    method: 'GET',
    match: regex(/^\/api\/spaces\/([^/]+)\/memories\/([^/]+)$/, ['space', 'name']),
    handle: ({ params, store, json, err }) => {
      const memory = store.getMemory(params.space!, params.name!);
      if (!memory) return err('Memory not found', 404);
      return json(presentMemoryDetail(memory));
    },
  },
  {
    method: 'PATCH',
    match: regex(/^\/api\/spaces\/([^/]+)\/memories\/([^/]+)$/, ['space', 'name']),
    handle: async ({ params, req, store, json, err }) => {
      const space = params.space!;
      const name = params.name!;
      const memory = store.getMemory(space, name);
      if (!memory) return err('Memory not found', 404);

      const body = (await req.json()) as {
        content?: string;
        pinned?: boolean;
        addTag?: string;
        removeTag?: string;
        promote?: boolean;
        demote?: boolean;
      };

      if (body.content !== undefined)
        await store.updateMemory(memory.id, { content: body.content });
      if (body.promote) store.promote(memory.id);
      if (body.demote) store.demote(memory.id);
      if (body.pinned === true) store.pin(memory.id);
      if (body.pinned === false) store.unpin(memory.id);
      if (body.addTag) store.addMemoryTag(memory.id, body.addTag);
      if (body.removeTag) store.removeMemoryTag(memory.id, body.removeTag);

      return json(store.getMemoryById(memory.id));
    },
  },
  {
    method: 'DELETE',
    match: regex(/^\/api\/spaces\/([^/]+)\/memories\/([^/]+)$/, ['space', 'name']),
    handle: ({ params, store, json }) => {
      store.deleteMemoryByName(params.space!, params.name!);
      return json({ ok: true });
    },
  },
];
