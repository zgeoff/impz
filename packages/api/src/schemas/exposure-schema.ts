import * as z from 'zod';
import { NameSchema } from './name-schema';

/* @internal */
export const ExposureSchema = z.enum(['tailnet', 'public']);
export const PublicAuthSchema = z.enum(['none', 'token', 'basic']);

export type PublicAuth = z.infer<typeof PublicAuthSchema>;

// A colon ends the user name in a basic auth header.
export const BasicUserSchema = z
  .string()
  .regex(/^[!-9;-~]{1,64}$/u, 'must be 1 to 64 printable characters, without a colon');

export const ExposeInputSchema = z
  .object({
    name: NameSchema,

    auth: PublicAuthSchema.default('token'),

    user: BasicUserSchema.optional(),
  })
  .refine((input) => input.auth === 'basic' || input.user === undefined, {
    message: 'only basic auth takes a user',
    path: ['user'],
  });

export const ExposeResultSchema = z.object({
  url: z.url(),
  auth: PublicAuthSchema,
  user: z.string().nullable(),

  credential: z.string().nullable(),

  warning: z.string().optional(),
});

export type ExposeResult = z.infer<typeof ExposeResultSchema>;
