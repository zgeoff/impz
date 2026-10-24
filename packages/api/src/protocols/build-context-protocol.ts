import * as z from 'zod';
import { NameSchema } from '../schemas/name-schema';

export const BUILD_CONTEXT_PATH = '/images/build-context';

export const DockerfilePathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split(/[/\\]/u).includes('..'), {
    message: 'the Dockerfile path must be relative and stay inside the build context',
  });

export const BuildContextQuerySchema = z.object({
  name: NameSchema,
  dockerfile: DockerfilePathSchema.optional(),
});

export type BuildContextQuery = z.infer<typeof BuildContextQuerySchema>;

// JSON carries the date as a string.
export const BuildContextUploadSchema = z.object({
  id: z.string().min(1),
  expiresAt: z.coerce.date(),
});

export type BuildContextUpload = z.infer<typeof BuildContextUploadSchema>;

export const BuildContextErrorSchema = z.object({ code: z.string(), message: z.string() });
