import * as z from 'zod';

export const CheckpointSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  createdAt: z.date(),
  sizeBytes: z.int().nonnegative().optional(),

  diskMib: z.int().positive(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
