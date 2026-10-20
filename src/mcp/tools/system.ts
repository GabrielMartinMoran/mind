import { getSystemInstructionsHandler } from '../handlers/system/get-system-instructions';
import { SystemInstructionsSchema } from '../schemas/system/get-system-instructions';
import type { ToolDefinition } from '../tool-types';

export interface SystemTools {
  system_instructions: ToolDefinition;
}

export function createSystemTools(): SystemTools {
  return {
    system_instructions: {
      schema: SystemInstructionsSchema,
      description:
        'Returns the complete Mind protocol: ORIENT, RECALL, LEARN, RELATE, MAINTAIN, and HANDOFF guidance with tool examples. Read it when you need the full reference.',
      annotations: { readOnlyHint: true },
      handler: getSystemInstructionsHandler,
    },
  };
}
