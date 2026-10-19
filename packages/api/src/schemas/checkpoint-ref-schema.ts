import * as z from 'zod';

// a checkpoint is addressed by its id or by its label
export const CheckpointRefSchema = z.string().min(1);
