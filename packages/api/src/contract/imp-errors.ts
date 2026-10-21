import * as z from 'zod';
import { ImpStateSchema } from '../schemas/imp-schema';
import { LeaseSummarySchema } from '../schemas/lease-schema';
import { NameSchema } from '../schemas/name-schema';
import { ColdBootsSchema, InvalidResumeDataSchema } from '../schemas/session-output-schema';
import { defineErrors } from './define-errors';

const ResourceKindSchema = z.enum([
  'imp',
  'image',
  'checkpoint',
  'session',
  'service',
  'secret',
  'grant',
  'backup',
  'token',
  'ssh-key',
  'network',
  'oauth-client',
  'oauth-grant',
  'oauth-approval',
  'database-copy',
]);

const ResourceDataSchema = z.object({
  kind: ResourceKindSchema,
  name: z.string(),

  reason: z.enum(['binding_changed']).optional(),
});

const ForbiddenReasonSchema = z.enum(['imp_out_of_scope', 'not_grantable', 'scope']);

export type ForbiddenReason = z.infer<typeof ForbiddenReasonSchema>;

const ForbiddenDataSchema = z.object({ reason: ForbiddenReasonSchema });

// The client raises impd_outdated itself, for an impd too old to check an
// exec requirement; impd never sends it.
const PreconditionDataSchema = z.object({
  reason: z.enum(['broker_not_ready', 'impd_outdated']),
  detail: z.string(),
});

const ProtectedImpSchema = z.object({
  name: NameSchema,
  ramMib: z.int().nonnegative(),
  leased: z.boolean(),
  busy: z.boolean(),
});

export const IMP_ERRORS = defineErrors({
  NOT_FOUND: { message: 'Not found', data: ResourceDataSchema },
  CONFLICT: { message: 'Already exists', data: ResourceDataSchema },

  FORBIDDEN: { message: 'Not allowed', data: ForbiddenDataSchema.optional() },

  PRECONDITION_FAILED: {
    message: 'Not possible on this host',
    data: PreconditionDataSchema.optional(),
  },
  RAM_BUDGET_EXCEEDED: {
    message: 'Not enough RAM budget, even after sleeping idle imps',
    status: 503,
    data: z.object({
      budgetMib: z.int().nonnegative(),
      usedMib: z.int().nonnegative(),
      requestedMib: z.int().nonnegative(),

      neededMib: z.int().nonnegative().optional(),
      protected: z.array(ProtectedImpSchema).readonly().optional(),
      protectedHidden: z.int().nonnegative().optional(),
    }),
  },

  SERVICE_UNAVAILABLE: { message: 'impd is stopping' },
  INVALID_STATE: {
    message: 'The imp is not in a state that allows this',
    status: 409,
    data: z.object({
      state: ImpStateSchema,
      allowed: z.array(ImpStateSchema),

      coldBoots: ColdBootsSchema.optional(),
    }),
  },

  INVALID_RESUME: {
    message: 'The resume offset is past the end of the output',
    status: 409,
    data: InvalidResumeDataSchema,
  },

  DISK_FULL: {
    message: 'Not enough free disk on the host',
    status: 507,
    data: z.object({
      availableBytes: z.int().nonnegative(),
      reserveBytes: z.int().nonnegative(),
      requestedBytes: z.int().nonnegative(),
    }),
  },

  LEASED: {
    message: 'The imp is leased',
    status: 409,
    data: LeaseSummarySchema,
  },

  LEASE_NOT_HELD: { message: 'The caller holds no such lease', status: 409 },

  AGENT_OUTDATED: { message: "The imp's agent is too old for this", status: 409 },

  MOVING: {
    message: 'The imp is moving between hosts',
    status: 409,
    data: z.object({ retryAfterS: z.int().positive() }),
  },
});
