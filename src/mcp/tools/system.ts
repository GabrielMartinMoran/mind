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
        'Returns the complete fallback copy of the Mind protocol when the `mind-management` skill is not listed or cannot be loaded.',
      annotations: { readOnlyHint: true },
      handler: getSystemInstructionsHandler,
    },
  };
}
