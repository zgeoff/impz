import * as z from 'zod';

export const StubGuestMemorySchema = z.object({
  pages: z.string(),
  dirtyPages: z.array(z.number()),
  isTrackingDirtyPages: z.boolean(),
});

export type StubGuestMemory = z.infer<typeof StubGuestMemorySchema>;
