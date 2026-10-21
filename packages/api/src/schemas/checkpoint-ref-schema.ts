import * as z from 'zod';

export const CheckpointRefSchema = z.string().min(1);
