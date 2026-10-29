import * as z from 'zod';

export const StubGuestMemorySchema = z.object({
  pages: z.string(),
  dirtyPages: z.array(z.number()),
  isTrackingDirtyPages: z.boolean(),

  // a 2M guest's Diff of untracked memory holds the pages mincore(2) finds
  hugePages: z.enum(['None', '2M']).optional(),
  presentPages: z.array(z.number()).optional(),
});

export type StubGuestMemory = z.infer<typeof StubGuestMemorySchema>;
