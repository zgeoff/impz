import * as z from 'zod';
import { OffsetSchema } from './offset-schema';

export const ExecutionGenerationSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const COLD_BOOT_CAUSES = [
  'start',
  'wake_fallback',
  'watchdog',
  'restore',
  'recovery',
  'unknown',
] as const;

export const ColdBootCauseSchema = z.enum(COLD_BOOT_CAUSES);

export type ColdBootCause = z.infer<typeof ColdBootCauseSchema>;

export const ColdBootSchema = z
  .object({
    bootId: z.string(),
    cause: ColdBootCauseSchema,
    at: z.iso.datetime(),
  })
  .readonly();

export type ColdBoot = z.infer<typeof ColdBootSchema>;

export const ColdBootsSchema = z.array(ColdBootSchema).max(4).readonly();

export const PreviousGenerationSchema = z
  .object({
    executionGeneration: ExecutionGenerationSchema,
    end: OffsetSchema,
    exitCode: z.int().nullable(),
  })
  .readonly();

export type PreviousGeneration = z.infer<typeof PreviousGenerationSchema>;

export const ResumeFromSchema = z
  .object({
    executionGeneration: ExecutionGenerationSchema,
    offset: OffsetSchema,
  })
  .readonly();

export type ResumeFrom = z.infer<typeof ResumeFromSchema>;

export const ResumeResultSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('exact') }),
    z.object({ kind: z.literal('gap'), from: OffsetSchema, to: OffsetSchema }),
    z.object({
      kind: z.literal('generation_changed'),
      executionGeneration: ExecutionGenerationSchema,
      firstOffset: OffsetSchema,
    }),
  ])
  .readonly();

export type ResumeResult = z.infer<typeof ResumeResultSchema>;

const SessionLogStateSchema = z.object({ enabled: z.boolean() }).readonly();

export const SessionOutputSchema = z
  .discriminatedUnion('continuity', [
    z.object({ continuity: z.literal('none') }),
    z.object({
      continuity: z.literal('offsets'),
      bootId: z.string(),
      executionGeneration: ExecutionGenerationSchema,

      bufferStart: OffsetSchema,
      end: OffsetSchema,

      offset: OffsetSchema,
      prelude: OffsetSchema,
      coldBoots: ColdBootsSchema,
      previous: PreviousGenerationSchema.optional(),

      resume: ResumeResultSchema.optional(),

      log: SessionLogStateSchema.optional(),
    }),
  ])
  .readonly();

export type SessionOutput = z.infer<typeof SessionOutputSchema>;

export const NoSessionDataSchema = z
  .object({
    bootId: z.string(),
    coldBoots: ColdBootsSchema,
    previous: PreviousGenerationSchema.optional(),
  })
  .readonly();

export type NoSessionData = z.infer<typeof NoSessionDataSchema>;

export const InvalidResumeDataSchema = z
  .object({ end: OffsetSchema, bufferStart: OffsetSchema })
  .readonly();

export type InvalidResumeData = z.infer<typeof InvalidResumeDataSchema>;
