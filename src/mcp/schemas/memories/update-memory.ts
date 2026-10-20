import { z } from 'zod';

export const MemoryUpdateSchema = z.object({
  space: z.string().min(1).describe('Space containing the memory.'),
  name: z.string().min(1).describe('Current memory name to update.'),
  newName: z.string().optional().describe('New memory name (rename).'),
  content: z.string().optional().describe('New content.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('New tags array (replaces existing). Omit to keep existing tags.'),
  pinned: z.boolean().optional().describe('Pin or unpin the memory in its current tier.'),
  tierTransition: z
    .enum(['promote', 'demote'])
    .optional()
    .describe('Move the memory one tier up (promote) or down (demote).'),
});
