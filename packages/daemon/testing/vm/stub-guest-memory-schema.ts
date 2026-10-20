import * as z from 'zod';

// The guest memory of the stub Firecracker, which start-stub-firecracker.ts
// passes to run-stub-firecracker.ts as JSON: one fill character per 4 KiB
// page, and the pages the guest wrote since its load.
export const StubGuestMemorySchema = z.object({
  pages: z.string(),
  dirtyPages: z.array(z.number()),
  isTrackingDirtyPages: z.boolean(),
});

export type StubGuestMemory = z.infer<typeof StubGuestMemorySchema>;
