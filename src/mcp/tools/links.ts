import type { MindStore } from '../../store/mind-store';
import { createLinkHandler } from '../handlers/links/create-link';
import { deleteLinkHandler } from '../handlers/links/delete-link';
import { LinkCreateSchema } from '../schemas/links/create-link';
import { LinkDeleteSchema } from '../schemas/links/delete-link';
import type { ToolDefinition } from '../tool-types';

const LINK_TOOL_DESCRIPTIONS: Record<string, string> = {
  link_create:
    'Create a directional link from sourceRef to targetRef. label describes the relation (depends_on, caused_by, extends, implements, contradicts, relates_to). Re-creating the same directed pair replaces its label.',
  link_delete:
    'Remove a directional link between two memories. Deleting an absent link succeeds as a no-op; the memories themselves are unaffected.',
};

export interface LinkTools {
  link_create: ToolDefinition;
  link_delete: ToolDefinition;
}

export function createLinkTools(store: MindStore): LinkTools {
  return {
    link_create: {
      schema: LinkCreateSchema,
      description: LINK_TOOL_DESCRIPTIONS.link_create,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      handler: createLinkHandler(store),
    },
    link_delete: {
      schema: LinkDeleteSchema,
      description: LINK_TOOL_DESCRIPTIONS.link_delete,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: deleteLinkHandler(store),
    },
  };
}
