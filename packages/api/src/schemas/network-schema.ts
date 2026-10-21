import * as z from 'zod';
import { NameSchema } from './name-schema';

export const NetworkSchema = z.object({
  name: NameSchema,

  imps: z.array(NameSchema).readonly(),
  createdAt: z.date(),
});

export type Network = z.infer<typeof NetworkSchema>;

export const NetworkJoinSchema = NetworkSchema.extend({ warning: z.string().nullable() });

export type NetworkJoin = z.infer<typeof NetworkJoinSchema>;

export const MAX_CREATE_NETWORKS = 16;
