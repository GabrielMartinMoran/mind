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
    'Update a memory by space and name. Supports newName and content, replaces tags when tags is provided, sets pinned, and moves one tier with tierTransition (promote/demote). Explicit transitions move pinned memories.',
  memory_delete: 'Permanently delete a memory and all its links.',
  memory_read:
    'Read a memory with its direct relations. links_to lists outgoing relations and linked_by lists incoming relations; each summary includes the stored label and direction. Auto-promotes tier (T3→T2→T1) unless noPromote:true. Use when actively working with a memory.',
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
        'Query memories by metadata, date, or relevance search. search supports quoted phrases, OR/AND/NOT, and a trailing * prefix; results include a confidence bucket. Score, methods, and search_method appear only when USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is exactly "true". Use space="*" for all spaces. Does not record access or promote tiers.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: queryMemoriesHandler(store),
    },
  };
}

export type { TierChange };
