import * as z from 'zod';
import { ImageSchema } from './image-schema';

export const ImageBuildPhaseSchema = z.enum(['upload', 'pack', 'build', 'pull', 'unpack', 'copy']);
export const IMAGE_BUILD_LOG_MAX_CHARS = 8192;

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

export const ImageOpEventSchema = z.discriminatedUnion('type', [
  ImageBuildProgressSchema,
  ImageBuildLogSchema,
  z.object({ type: z.literal('image'), image: ImageSchema }),
]);

export type ImageOpEvent = z.infer<typeof ImageOpEventSchema>;

export type ImageBuildPhase = z.infer<typeof ImageBuildPhaseSchema>;

export type ImageBuildProgress = z.infer<typeof ImageBuildProgressSchema>;

export type ImageBuildLog = z.infer<typeof ImageBuildLogSchema>;
