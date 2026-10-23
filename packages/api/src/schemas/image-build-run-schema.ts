import * as z from 'zod';
import { ImageBuildPhaseSchema } from './image-op-event-schema';
import { NameSchema } from './name-schema';

export const ImageBuildSourceSchema = z.enum(['upload', 'host']);

export const ImageBuildRunSchema = z.object({
  name: NameSchema,
  source: ImageBuildSourceSchema,
  startedAt: z.date(),
  phase: ImageBuildPhaseSchema,
  step: z.string().nullable(),
  builder: z.string().nullable(),
});

export type ImageBuildRun = z.infer<typeof ImageBuildRunSchema>;

export type ImageBuildSource = z.infer<typeof ImageBuildSourceSchema>;
