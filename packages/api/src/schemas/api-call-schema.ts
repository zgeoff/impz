import * as z from 'zod';
import { NameSchema } from './name-schema';

// `oauth` is a caller that signed in to impd through its own OAuth server. An
// `oauth` secret kind is another thing: a refresh token for another service.
export const ApiActorSchema = z.enum(['token', 'dashboard', 'ssh', 'tailnet', 'oauth']);

export type ApiActor = z.infer<typeof ApiActorSchema>;

// A row never holds the call's input, because adding a secret carries its value.
export const ApiCallSchema = z.object({
  at: z.date(),
  procedure: z.string(),
  actor: ApiActorSchema,

  actorName: z.string().optional(),

  imp: NameSchema.optional(),

  outcome: z.string(),
  durationMs: z.int().nonnegative(),

  detail: z.string().optional(),
});

export type ApiCall = z.infer<typeof ApiCallSchema>;
