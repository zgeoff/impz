import {
  AGENT_EXEC_FIELDS,
  GOVERNOR_DECISION_FIELDS,
  ImpChangeReasonSchema,
  ImpEventDetailSchema,
  ImpKindSchema,
  ImpStateSchema,
  MoveStateSchema,
  PublicAuthSchema,
} from '@impz/api';
import * as z from 'zod';
import type { CheckpointRecord } from './checkpoints';
import type { ImpRecord } from './imps';

// epoch milliseconds: z.iso.datetime refuses the six-digit year of a lease with no end
const StoredDateSchema = z.codec(z.number(), z.date(), {
  decode: (epochMs) => new Date(epochMs),
  encode: (date) => date.getTime(),
});

// a row written before a field joined the record lacks it, so a new field needs a default here
const StoredImpSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageId: z.string(),
  imageDigest: z.string(),
  state: ImpStateSchema,
  kind: ImpKindSchema,
  vcpus: z.int(),
  memoryMib: z.int(),
  maxMemoryMib: z.int(),
  slot: z.int(),
  ip: z.string(),
  createdAt: StoredDateSchema,
  lastActiveAt: StoredDateSchema,
  lastRequestAt: StoredDateSchema.nullable(),
  sleptAt: StoredDateSchema.nullable(),
  holdUntil: StoredDateSchema.nullable(),
  error: z.string().nullable(),
  hasOopsHold: z.boolean(),
  oopsBootId: z.string().nullable(),
  pid: z.int().nullable(),
  firecrackerVersion: z.string().nullable(),
  httpPort: z.int(),
  diskBytes: z.number(),
  isDiskGrowPending: z.boolean(),
  publicAuth: PublicAuthSchema.nullable(),
  cpu: z.object({ limit: z.number().nullable(), weight: z.number() }),
  wakeCount: z.int(),
  jailUid: z.int().nullable(),
  awakeMs: z.number(),
  awakeSince: StoredDateSchema.nullable(),
  isIdentityResetPending: z.boolean(),
  isBackedUp: z.boolean(),
  isTrustPending: z.boolean(),
  moveState: MoveStateSchema.nullable(),
}) satisfies z.ZodType<ImpRecord>;

const StoredCheckpointSchema = z.object({
  id: z.string(),
  impId: z.string(),
  label: z.string().nullable(),
  createdAt: StoredDateSchema,
  sizeBytes: z.number().nullable(),
  diskBytes: z.number(),
}) satisfies z.ZodType<CheckpointRecord>;

export const ImpLogEntrySchema = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('ImpAdded'), imp: StoredImpSchema }),
  z.object({
    ev: z.literal('ImpChanged'),
    imp: StoredImpSchema,
    reason: ImpChangeReasonSchema,
    detail: ImpEventDetailSchema.optional(),
  }),
  z.object({ ev: z.literal('ImpRemoved'), imp: StoredImpSchema }),
  z.object({
    ev: z.enum(['CheckpointAdded', 'CheckpointRemoved']),
    name: z.string(),
    checkpoint: StoredCheckpointSchema,
  }),

  // any name reads back, so impd's own followers see an event the API's name rule refuses
  z.object({ ...GOVERNOR_DECISION_FIELDS, name: z.string() }),
  z.object({ ...AGENT_EXEC_FIELDS, name: z.string() }),
]);

export type ImpLogEntry = z.output<typeof ImpLogEntrySchema>;

export type StoredImpLogEntry = z.input<typeof ImpLogEntrySchema>;

export type LoggedImpEvent = ImpLogEntry & { readonly seq: number; readonly at: Date };
