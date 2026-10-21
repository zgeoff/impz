import * as z from 'zod';
import { ImageSchema } from '../schemas/image-schema';
import { NameSchema } from '../schemas/name-schema';

export const IMAGE_BUILD_PATH = '/images/build';

// A request that accepts this gets build events from the start, because a
// client's fetch gives up on minutes of silence.
export const IMAGE_BUILD_STREAM_TYPE = 'application/x-ndjson';

export const DockerfilePathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split(/[/\\]/u).includes('..'), {
    message: 'the Dockerfile path must be relative and stay inside the build context',
  });

export const ImageBuildQuerySchema = z.object({
  name: NameSchema,
  dockerfile: DockerfilePathSchema.optional(),
});

export type ImageBuildQuery = z.infer<typeof ImageBuildQuerySchema>;

// JSON carries the image's date as a string.
export const ImageBuildResultSchema = ImageSchema.extend({ createdAt: z.coerce.date() });
export const ImageBuildErrorSchema = z.object({ code: z.string(), message: z.string() });
export const ImageBuildPhaseSchema = z.enum(['upload', 'pack', 'build', 'pull', 'unpack', 'copy']);
export const IMAGE_BUILD_LOG_MAX_CHARS = 8192;

// A client skips an event type it does not know, so a newer impd can add one.
const ImageBuildProgressSchema = z.object({
  type: z.literal('progress'),
  phase: ImageBuildPhaseSchema,
  elapsedMs: z.number().nonnegative(),
  step: z.string().optional(),
});

const ImageBuildLogSchema = z.object({
  type: z.literal('log'),
  text: z.string().max(IMAGE_BUILD_LOG_MAX_CHARS),
});

export const ImageBuildEventSchema = z.discriminatedUnion('type', [
  ImageBuildProgressSchema,
  ImageBuildLogSchema,
  z.object({ type: z.literal('image'), image: ImageBuildResultSchema }),
  ImageBuildErrorSchema.extend({ type: z.literal('error') }),
]);

export const ImageOpEventSchema = z.discriminatedUnion('type', [
  ImageBuildProgressSchema,
  ImageBuildLogSchema,
  z.object({ type: z.literal('image'), image: ImageSchema }),
]);

export type ImageOpEvent = z.infer<typeof ImageOpEventSchema>;

export type ImageBuildPhase = z.infer<typeof ImageBuildPhaseSchema>;

export type ImageBuildProgress = z.infer<typeof ImageBuildProgressSchema>;

export type ImageBuildLog = z.infer<typeof ImageBuildLogSchema>;

export type ImageBuildEvent = z.input<typeof ImageBuildEventSchema>;
