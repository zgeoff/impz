import {
  ColdBootCauseSchema,
  GrantFilterSchema,
  ImageSourceSchema,
  LeaseLabelSchema,
  WarmMoveSchema,
} from '@impz/api';
import * as z from 'zod';
import { SnapshotMetaSchema } from '../../vm/sleep/snapshot-meta';
import { VmIdentitySchema } from '../../vm/sleep/vm-identity';

const CpuSchema = z.object({ limit: z.number().positive().nullable(), weight: z.int() }).readonly();

const EgressSchema = z
  .object({ mode: z.string(), allow: z.array(z.string()).readonly() })
  .readonly();

const CheckpointSchema = z
  .object({
    label: z.string().nullable(),
    createdAt: z.coerce.date(),
    diskBytes: z.int().positive(),
  })
  .readonly();

const MovedBootSchema = z
  .object({ bootId: z.uuid(), cause: ColdBootCauseSchema, at: z.iso.datetime() })
  .readonly();

export const MAX_MOVED_LEASES = 1024;
export const MAX_LEASE_REMAINING_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const LeaseOwnerTextSchema = z.string().min(1).max(256);

export const MovedLeaseOwnerSchema = z.object({
  principal: LeaseOwnerTextSchema,
  label: LeaseLabelSchema,
  display: LeaseOwnerTextSchema,
});

// The target ends a lease the time it had left after reading the header, so
// the two hosts' clocks need not agree.
const MovedLeaseSchema = MovedLeaseOwnerSchema.extend({
  remainingMs: z.int().nonnegative().max(MAX_LEASE_REMAINING_MS).nullable(),
  createdAt: z.coerce.date(),
}).readonly();

export type MovedLease = z.infer<typeof MovedLeaseSchema>;

const FilteredGrantSchema = z.object({ secret: z.string(), filter: GrantFilterSchema }).readonly();

const ImpSchema = z
  .object({
    // The id names the target's datasets and paths, so only a UUID passes.
    id: z.uuid(),
    name: z.string(),
    vcpus: z.int().positive(),
    memoryMib: z.int().positive(),
    maxMemoryMib: z.int().positive().optional(),
    httpPort: z.int().positive(),
    diskBytes: z.int().positive(),
    cpu: CpuSchema,
    egress: EgressSchema,
    grants: z.array(z.string()).readonly(),

    // Kept apart from the plain grants, so a target that predates filters
    // drops them rather than grant the whole host.
    filteredGrants: z.array(FilteredGrantSchema).readonly().default([]),
    isIdentityResetPending: z.boolean(),
    isDiskGrowPending: z.boolean().default(false),
    isBackedUp: z.boolean().default(true),

    coldBoots: z.array(MovedBootSchema).max(4).readonly().default([]),
    leases: z.array(MovedLeaseSchema).max(MAX_MOVED_LEASES).readonly().optional(),
  })
  .readonly();

const StreamStepSchema = z
  .object({
    checkpoint: z.int().nonnegative().nullable(),
    dataset: z.int().nonnegative(),
    base: z.int().nonnegative().nullable(),
  })
  .readonly();

const HeldAnswerSchema = z
  .object({
    names: z.array(z.string()).readonly(),
    address: z.string(),
    ttlS: z.int().positive(),
  })
  .readonly();

const DriveSchema = z.string().regex(/^[\da-f]{64}$/v);

const WarmSchema = z
  .object({
    move: WarmMoveSchema,
    meta: SnapshotMetaSchema.extend({ systemDrive: DriveSchema }),
    vm: VmIdentitySchema.nullable(),
    isDriveIncluded: z.boolean(),
    answers: z.array(HeldAnswerSchema).readonly(),
  })
  .readonly();

export const MoveHeaderSchema = z
  .object({
    version: z.literal(1),
    imp: ImpSchema,
    image: z.object({
      name: z.string(),
      ref: z.string(),
      digest: z.string(),
      receivedDigest: z.string().nullable().default(null),
      sizeBytes: z.int().nonnegative(),
      source: ImageSourceSchema,
      sourceImp: z.string().nullable(),
      isIncluded: z.boolean(),
    }),

    checkpoints: z.array(CheckpointSchema).readonly(),
    streams: z.array(StreamStepSchema).readonly().nullable(),
    warm: WarmSchema.nullable().default(null),
  })
  .readonly();

export type MoveHeader = z.infer<typeof MoveHeaderSchema>;

export const MoveOfferSchema = z.object({
  imageDigest: z.string(),
  receivedImageDigest: z.string().nullable().default(null),
  systemDrive: DriveSchema.optional(),
});

export const MoveOfferReplySchema = z.object({
  needsImage: z.boolean(),
  needsSystemDrive: z.boolean().default(false),
  storage: z.enum(['xfs', 'zfs']),
  keepsMaxMemory: z.boolean().default(false),
  keepsLeases: z.boolean().default(false),
  keepsPublicEgress: z.boolean().default(false),
  keepsBackupOff: z.boolean().default(false),
});

export const MoveCommitReplySchema = z.object({ isCommitted: z.boolean() });
export const MOVE_PART_HEADER = 'x-imp-move-part';
export const MOVE_FINISH_HEADER = 'x-imp-move-finish';

export const MOVE_PATHS = {
  offer: '/move/offer',
  receive: '/move/receive',
  commit: '/move/commit',
  abort: '/move/abort',
} as const;
