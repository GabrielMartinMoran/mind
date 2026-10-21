import type { MindStore } from '../../store/mind-store';
import { createSpaceHandler } from '../handlers/spaces/create-space';
import { deleteSpaceHandler } from '../handlers/spaces/delete-space';
import { getSpaceHandler } from '../handlers/spaces/get-space';
import { listSpacesHandler } from '../handlers/spaces/list-spaces';
import { updateSpaceHandler } from '../handlers/spaces/update-space';
import { SpaceCreateSchema } from '../schemas/spaces/create-space';
import { SpaceDeleteSchema } from '../schemas/spaces/delete-space';
import { SpaceGetSchema } from '../schemas/spaces/get-space';
import { SpaceListSchema } from '../schemas/spaces/list-spaces';
import { SpaceUpdateSchema } from '../schemas/spaces/update-space';
import type { ToolDefinition } from '../tool-types';

const SPACE_TOOL_DESCRIPTIONS: Record<string, string> = {
  space_create:
    'Create a new space with required tags. Use hierarchical names like projects/<repo>, user/preferences, or global/config.',
  space_list: 'List all spaces, optionally filtered by tag.',
  space_get:
    'Get a space orientation summary: overview counts, T1/T2/T3 previews with T3 availability, living references, and active checkpoints. Use at session start or when switching tasks.',
  space_update: 'Update a space description and/or replace its tags.',
  space_delete: 'Permanently delete a space and ALL its memories, links, and checkpoints.',
};

export interface SpaceTools {
  space_create: ToolDefinition;
  space_list: ToolDefinition;
  space_get: ToolDefinition;
  space_update: ToolDefinition;
  space_delete: ToolDefinition;
}

export function createSpaceTools(store: MindStore): SpaceTools {
  return {
    space_create: {
      schema: SpaceCreateSchema,
      description: SPACE_TOOL_DESCRIPTIONS.space_create,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: createSpaceHandler(store),
    },
    space_list: {
      schema: SpaceListSchema,
      description: SPACE_TOOL_DESCRIPTIONS.space_list,
      annotations: { readOnlyHint: true },
      handler: listSpacesHandler(store),
    },
    space_get: {
      schema: SpaceGetSchema,
      description: SPACE_TOOL_DESCRIPTIONS.space_get,
      annotations: { readOnlyHint: true },
      handler: getSpaceHandler(store),
    },
    space_update: {
      schema: SpaceUpdateSchema,
      description: SPACE_TOOL_DESCRIPTIONS.space_update,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: updateSpaceHandler(store),
    },
    space_delete: {
      schema: SpaceDeleteSchema,
      description: SPACE_TOOL_DESCRIPTIONS.space_delete,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      handler: deleteSpaceHandler(store),
    },
  };
}
