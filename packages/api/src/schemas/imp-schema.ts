import * as z from 'zod';
import { PublicAuthSchema } from './exposure-schema';
import { LeaseSummarySchema } from './lease-schema';
import { MoveStateSchema } from './move-schema';
import { NameSchema } from './name-schema';
import { SecretNameSchema } from './secret-schema';

export const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);

export type ImpState = z.infer<typeof ImpStateSchema>;

/* @internal */
export const ImpKindSchema = z.enum(['user', 'builder']);

export type ImpKind = z.infer<typeof ImpKindSchema>;

const OutdatedPartSchema = z.enum(['firecracker', 'kernel', 'agent', 'impd', 'ipv6']);

export type OutdatedPart = z.infer<typeof OutdatedPartSchema>;

const ImpResourcesSchema = z.object({
  wakeCount: z.int().nonnegative(),
  awakeMs: z.int().nonnegative(),

  sample: z
    .object({
      measuredAt: z.date(),
      since: z.date(),

      cpuPercent: z.number().nonnegative().optional(),

      cpuThrottledMs: z.int().nonnegative(),

      // Counted from the guest's side: rx is what it received, tx what it sent.
      netRxBytes: z.int().nonnegative(),
      netTxBytes: z.int().nonnegative(),
    })
    .optional(),
});

export const ImpSchema = z.object({
  id: z.string(),
  name: NameSchema,
  image: NameSchema,
  state: ImpStateSchema,

  kind: ImpKindSchema.optional(),
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),

  maxMemoryMib: z.int().positive().optional(),

  pluggedMib: z.int().nonnegative().optional(),

  backup: z.boolean().optional(),

  diskMib: z.int().positive(),

  diskUsage: z
    .object({
      exclusiveBytes: z.int().nonnegative(),
      sharedBytes: z.int().nonnegative(),
      measuredAt: z.date(),

      isPartial: z.boolean(),
      isUpperBound: z.boolean(),
    })
    .optional(),
  ip: z.ipv4(),
  slot: z.int().nonnegative(),
  port: z.int().positive(),
  httpPort: z.int().positive(),
  url: z.url(),

  public: z.object({ auth: PublicAuthSchema }).optional(),
  createdAt: z.date(),
  lastActiveAt: z.date(),

  ramMib: z.int().nonnegative().optional(),

  rssMib: z.int().nonnegative().optional(),
  sleptAt: z.date().optional(),

  holdUntil: z.date().optional(),

  leases: LeaseSummarySchema.optional(),
  error: z.string().optional(),

  sessions: z.int().nonnegative().optional(),

  coldBootReason: z.string().optional(),

  agentSilentSince: z.date().optional(),

  inner: z
    .object({
      up: z.boolean(),
      restarts: z.int().nonnegative(),
      lastError: z.string().optional(),
    })
    .optional(),
  outdated: z.array(OutdatedPartSchema).readonly().optional(),

  cpu: z.object({ limit: z.number().positive().nullable(), weight: z.int() }).optional(),
  resources: ImpResourcesSchema.optional(),

  move: MoveStateSchema.optional(),
});

export type Imp = z.infer<typeof ImpSchema>;

/* @internal */
export const GrantNotCopiedReasonSchema = z.enum(['not-grantable', 'clash', 'no-secret']);

/* @internal */
export const GrantNotCopiedSchema = z.object({
  secret: SecretNameSchema,
  reason: GrantNotCopiedReasonSchema,
});

export type GrantNotCopied = z.infer<typeof GrantNotCopiedSchema>;

export const ForkResultSchema = ImpSchema.extend({
  grantsNotCopied: z.array(GrantNotCopiedSchema).readonly().optional(),

  grantsError: z.string().optional(),
});

export type ForkResult = z.infer<typeof ForkResultSchema>;
