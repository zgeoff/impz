import * as z from 'zod';

export const MoveStateSchema = z.enum(['sending', 'moved', 'receiving']);

export type MoveState = z.infer<typeof MoveStateSchema>;

// A caller passes a literal tailnet address, so no name lookup can send the
// move's bytes elsewhere.
export const PeerUrlSchema = z.url({ protocol: /^https?$/u });

export const WarmHostSchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  cpuModel: z.string(),
  cpuFlags: z.string(),
  dataDir: z.string(),
  storage: z.enum(['xfs', 'zfs']),
  subnet: z.string(),
  slotCount: z.int().positive(),
  brokerPort: z.int().positive(),
  dns: z.array(z.string()).readonly(),
});

export type WarmHost = z.infer<typeof WarmHostSchema>;

export const WarmMoveSchema = z.object({
  slot: z.int().nonnegative(),
  egressMode: z.string(),
  snapshot: z.object({
    firecrackerVersion: z.string(),
    snapshotVersion: z.string(),
    hostKernel: z.string(),

    cpuModel: z.string().nullable(),
    cpuFlags: z.string().nullable(),
    ipv6Prefix: z.string().nullable(),
  }),
  host: WarmHostSchema.pick({
    dataDir: true,
    storage: true,
    subnet: true,
    brokerPort: true,
    dns: true,
  }),
});

export type WarmMove = z.infer<typeof WarmMoveSchema>;

export const MovePlanSchema = z.object({
  bytes: z.int().nonnegative(),
  checkpoints: z.int().nonnegative(),
  warm: WarmMoveSchema.nullable(),
});

export type MovePlan = z.infer<typeof MovePlanSchema>;

export const MoveTicketSchema = z.object({
  ticket: z.string(),
  expiresAt: z.date(),
  peerUrl: PeerUrlSchema,
});

export type MoveTicket = z.infer<typeof MoveTicketSchema>;

export const MoveStatusSchema = z.object({
  state: MoveStateSchema.nullable(),
  peer: z.string().nullable(),
  sentBytes: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),

  isDone: z.boolean(),
  error: z.string().nullable(),
});

export type MoveStatus = z.infer<typeof MoveStatusSchema>;
