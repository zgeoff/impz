import * as z from 'zod';
import { ApiActorSchema } from './api-call-schema';
import { CheckpointSchema } from './checkpoint-schema';
import { ImpSchema } from './imp-schema';
import { NameSchema } from './name-schema';

// A reader ignores event fields it does not know.
export const EVENT_VERSION = 1;

export const ImpChangeReasonSchema = z.enum([
  'booted',
  'woke',
  'slept',
  'stopped',
  'failed',

  'repaired',

  'adopted',
  'held',
  'restored',

  'resized',

  'updated',

  'exposed',

  'released',
]);

export type ImpChangeReason = z.infer<typeof ImpChangeReasonSchema>;

export const ImpEventDetailSchema = z
  .object({
    durationMs: z.int().nonnegative().optional(),

    prepareMs: z.int().nonnegative().optional(),

    trigger: z.string().optional(),
    coldBootReason: z.string().optional(),

    steps: z.record(z.string(), z.int()).readonly().optional(),

    released: z.int().positive().optional(),

    memFileMib: z.int().nonnegative().optional(),
  })
  .readonly();

export type ImpEventDetail = z.infer<typeof ImpEventDetailSchema>;

const SeqSchema = z.int().nonnegative();

// oxlint-disable-next-line id-length -- `v` is the event format's version field
const envelope = { v: z.literal(EVENT_VERSION), at: z.date(), seq: SeqSchema, logId: z.string() };

export const GOVERNOR_DECISION_FIELDS = {
  ev: z.literal('GovernorDecision'),
  decision: z.enum(['admitted', 'refused', 'slept']),
  name: NameSchema,
  trigger: z.string(),
  usedMib: z.int().nonnegative(),
  budgetMib: z.int().positive(),
  reserveMib: z.int().nonnegative().optional(),
  neededMib: z.int().nonnegative().optional(),

  // A count, never names, because not every reader of the stream may see
  // those imps.
  protectedCount: z.int().nonnegative().optional(),
};

export const AGENT_EXEC_FIELDS = {
  ev: z.literal('AgentExec'),
  name: NameSchema,
  actor: ApiActorSchema,
  actorName: z.string(),
  tty: z.boolean(),
  command: z.string(),
};

export const ImpEventSchema = z.discriminatedUnion('ev', [
  z.object({
    ...envelope,
    ev: z.literal('ImpAdded'),
    reason: z.enum(['snapshot', 'created']),
    imp: ImpSchema,
  }),
  z.object({
    ...envelope,
    ev: z.literal('ImpChanged'),
    reason: ImpChangeReasonSchema,
    imp: ImpSchema,
    detail: ImpEventDetailSchema.optional(),
  }),

  z.object({ ...envelope, ev: z.literal('ImpRemoved'), imp: ImpSchema }),
  z.object({
    ...envelope,
    ev: z.literal('CheckpointAdded'),
    name: NameSchema,
    checkpoint: CheckpointSchema,
  }),
  z.object({
    ...envelope,
    ev: z.literal('CheckpointRemoved'),
    name: NameSchema,
    checkpoint: CheckpointSchema,
  }),

  z.object({ ...envelope, ...GOVERNOR_DECISION_FIELDS }),
  z.object({ ...envelope, ...AGENT_EXEC_FIELDS }),

  // the reader's cursor names no event this log still holds; a snapshot follows
  z.object({ ...envelope, ev: z.literal('Reset') }),
]);

export type ImpEvent = z.infer<typeof ImpEventSchema>;

export const EventCursorSchema = z.object({
  after: SeqSchema.optional(),
  logId: z.string().optional(),
});

export type EventCursor = z.infer<typeof EventCursorSchema>;

export const EventPageSchema = z.object({
  events: z.array(ImpEventSchema),
  after: SeqSchema,
  logId: z.string(),
  hasMore: z.boolean(),
});

export type EventPage = z.infer<typeof EventPageSchema>;
