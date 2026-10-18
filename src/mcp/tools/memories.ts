import type { MindStore } from '../../store/mind-store';
import { addMemoryHandler } from '../handlers/memories/add-memory';
import { deleteMemoryHandler } from '../handlers/memories/delete-memory';
import { queryMemoriesHandler } from '../handlers/memories/query-memories';
import { readMemoryHandler, type TierChange } from '../handlers/memories/read-memory';
import { updateMemoryHandler } from '../handlers/memories/update-memory';
import { MemoryAddSchema } from '../schemas/memories/add-memory';
import { MemoryDeleteSchema } from '../schemas/memories/delete-memory';
import { MemoryQuerySchema } from '../schemas/memories/query-memories';
import { MemoryReadSchema } from '../schemas/memories/read-memory';
import { MemoryUpdateSchema } from '../schemas/memories/update-memory';
import type { ToolDefinition } from '../tool-types';

const MEMORY_TOOL_DESCRIPTIONS: Record<string, string> = {
  memory_add:
    'Add a memory to a space with tags. Use after decisions, bug fixes, discoveries, or config changes. Returns links_created and links_failed arrays.',
  memory_update:
    'Update a memory name, content, or tags. Use when memory content or metadata changes.',
  memory_delete: 'Permanently delete a memory and all its links.',
  memory_read:
    'Read a memory with links. Auto-promotes tier (T3→T2→T1) unless noPromote:true. Use when actively working with a memory.',
};

export interface MemoryTools {
  memory_add: ToolDefinition;
  memory_update: ToolDefinition;
  memory_delete: ToolDefinition;
  memory_read: ToolDefinition;
  memory_query: ToolDefinition;
}

export function createMemoryTools(store: MindStore): MemoryTools {
  return {
    memory_add: {
      schema: MemoryAddSchema,
      description: MEMORY_TOOL_DESCRIPTIONS.memory_add,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: addMemoryHandler(store),
    },
    memory_update: {
      schema: MemoryUpdateSchema,
      description: MEMORY_TOOL_DESCRIPTIONS.memory_update,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: updateMemoryHandler(store),
    },
    memory_delete: {
      schema: MemoryDeleteSchema,
      description: MEMORY_TOOL_DESCRIPTIONS.memory_delete,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      handler: deleteMemoryHandler(store),
    },
    memory_read: {
      schema: MemoryReadSchema,
      description: MEMORY_TOOL_DESCRIPTIONS.memory_read,
      annotations: { readOnlyHint: false },
      handler: readMemoryHandler(store),
    },
    memory_query: {
      schema: MemoryQuerySchema,
      description:
        'Query memories by metadata, date, or relevance search (the search param supports quoted phrases, OR/AND/NOT and a trailing * prefix; results include confidence and methods). Use space="*" for all spaces.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: queryMemoriesHandler(store),
    },
  };
}

export type { TierChange };
