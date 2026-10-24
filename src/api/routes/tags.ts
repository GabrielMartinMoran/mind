import type { RouteDefinition } from './types';
import { regex } from './types';

export const tagRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    match: regex(/^\/api\/spaces\/([^/]+)\/tags$/, ['space']),
    handle: ({ params, store, json }) => json(store.listMemoryTags(params.space!)),
  },
];
