import { z } from 'zod';

export const LinkCreateSchema = z.object({
  sourceRef: z
    .string()
    .describe('Source memory ref ("space:name" or bare "name" uses source space).'),
  targetRef: z
    .string()
    .describe('Target memory ref ("space:name" or bare "name" uses source space).'),
  label: z
    .string()
    .optional()
    .describe(
      'Relationship label (e.g., "depends_on", "caused_by", "extends"). Re-creating the same directed pair replaces the label.'
    ),
});
