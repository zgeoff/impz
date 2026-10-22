import * as z from 'zod';
import { ImpStateSchema } from './imp-schema';

// A service's name is its file name in the guest, and the guest agent checks
// the same rule.
export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export const ServiceNameSchema = z
  .string()
  .regex(
    SERVICE_NAME_PATTERN,
    'must be a lowercase letter or digit followed by up to 62 lowercase letters, digits or -',
  );

// The guest agent holds the same cap.
export const SERVICE_LOG_MAX_LINES = 100_000;
export const ServiceRestartSchema = z.enum(['always', 'on-failure', 'never']);
const EnvEntrySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=/u, 'must be KEY=VALUE');

export const ServiceDefSchema = z.object({
  name: ServiceNameSchema,
  argv: z.array(z.string().min(1)).min(1).max(256).readonly(),
  env: z.array(EnvEntrySchema).max(256).readonly().optional(),
  cwd: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  restart: ServiceRestartSchema.optional(),
});

export const ServiceStateSchema = z.enum(['starting', 'running', 'backoff', 'stopped', 'exited']);

/* @internal */
export const ServiceSchema = z.object({
  name: z.string(),
  state: ServiceStateSchema,
  pid: z.int().positive().nullable(),

  restarts: z.int().nonnegative(),

  lastExit: z.object({ code: z.int(), signal: z.string().nullable() }).nullable(),
  argv: z.array(z.string()).readonly(),

  // Keys only, because a value can hold a secret.
  envKeys: z.array(z.string()).readonly(),
  cwd: z.string().nullable(),
  user: z.string().nullable(),
  restart: ServiceRestartSchema,

  source: z.enum(['image', 'api']),

  root: z.boolean(),
});

export const ServiceLogSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), service: z.string(), text: z.string() }),

  z.object({ type: z.literal('sleeping'), state: ImpStateSchema }),
  z.object({ type: z.literal('awake') }),
  z.object({ type: z.literal('restarting') }),
]);

export type ServiceDef = z.infer<typeof ServiceDefSchema>;

export type Service = z.infer<typeof ServiceSchema>;

export const ServiceListSchema = z.object({
  services: z.array(ServiceSchema).readonly(),
  recorded: z.boolean(),
});

export type ServiceList = z.infer<typeof ServiceListSchema>;

export type ServiceLog = z.infer<typeof ServiceLogSchema>;
