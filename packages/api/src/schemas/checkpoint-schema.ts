import * as z from 'zod';

// a checkpoint is addressed by its id or by its label
export const CheckpointRefSchema = z.string().min(1);

export const CheckpointSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  createdAt: z.date(),
  sizeBytes: z.int().nonnegative().optional(),

  // the imp's disk size when it was taken; a restore or a fork takes it
  diskMib: z.int().positive(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
