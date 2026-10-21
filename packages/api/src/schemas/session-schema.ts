import * as z from 'zod';
import { ExecutionGenerationSchema } from './session-output-schema';

// The guest agent checks the same rule.
export const SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export const SessionNameSchema = z
  .string()
  .regex(
    SESSION_NAME_PATTERN,
    'must be a lowercase letter or digit followed by up to 31 lowercase letters, digits or hyphens',
  );

export const SessionExitSchema = z
  .object({
    code: z.int().nullable(),
    signal: z.string().nullable(),
  })
  .readonly();

export const SessionSchema = z.object({
  name: SessionNameSchema,
  pid: z.int().positive(),
  argv: z.array(z.string()).readonly(),
  state: z.enum(['running', 'exited']),

  attached: z.boolean(),
  cols: z.int().positive(),
  rows: z.int().positive(),

  startedAt: z.date(),

  exit: SessionExitSchema.optional(),

  continuity: z.enum(['none', 'offsets']).optional(),
  executionGeneration: ExecutionGenerationSchema.optional(),
  bootId: z.string().optional(),
  end: z.int().nonnegative().optional(),
  endObservedAt: z.date().optional(),

  log: z.boolean().optional(),
});

export type Session = z.infer<typeof SessionSchema>;
