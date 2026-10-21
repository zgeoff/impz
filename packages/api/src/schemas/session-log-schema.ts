import * as z from 'zod';
import { NameSchema } from './name-schema';
import { OffsetSchema } from './offset-schema';
import { ExecutionGenerationSchema } from './session-output-schema';
import { SessionNameSchema } from './session-schema';

export const SESSION_LOG_READ_MAX_BYTES = 1_048_576;

export const SessionLogSchema = z
  .object({
    session: SessionNameSchema,
    executionGeneration: ExecutionGenerationSchema,

    bootId: z.string(),

    state: z.enum(['live', 'ended']),

    logStart: OffsetSchema,
    logEnd: OffsetSchema,

    bytes: OffsetSchema,

    end: OffsetSchema.optional(),
    exitCode: z.int().nullable().optional(),

    complete: z.boolean(),

    stopped: z.enum(['disk_full', 'imp_limit']).optional(),
    startedAt: z.date(),
    endedAt: z.date().optional(),
  })
  .readonly();

export type SessionLog = z.infer<typeof SessionLogSchema>;

export const SessionLogListInputSchema = z.object({
  name: NameSchema,
  session: SessionNameSchema.optional(),
});

export const SessionLogReadInputSchema = z.object({
  name: NameSchema,
  session: SessionNameSchema,
  executionGeneration: ExecutionGenerationSchema,
  from: OffsetSchema,
  limit: z.int().min(1).max(SESSION_LOG_READ_MAX_BYTES).optional(),
});

// After a gap, data is raw pty output that can start inside an escape sequence.
export const SessionLogReadSchema = z
  .object({
    offset: OffsetSchema,
    gap: z.object({ from: OffsetSchema, to: OffsetSchema }).readonly().optional(),
    data: z.instanceof(Blob),
    log: SessionLogSchema,
  })
  .readonly();

export type SessionLogRead = z.infer<typeof SessionLogReadSchema>;

export const SessionLogDeleteInputSchema = z
  .object({
    name: NameSchema,
    session: SessionNameSchema.optional(),
    executionGeneration: ExecutionGenerationSchema.optional(),
  })
  .refine((input) => input.executionGeneration === undefined || input.session !== undefined, {
    message: 'a generation is named with its session',
    path: ['executionGeneration'],
  });
