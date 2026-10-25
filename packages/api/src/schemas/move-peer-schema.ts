import * as z from 'zod';

export const SystemDriveSchema = z.string().regex(/^[\da-f]{64}$/v);

export const MoveOfferSchema = z.object({
  imageDigest: z.string(),
  receivedImageDigest: z.string().nullable().default(null),
  systemDrive: SystemDriveSchema.optional(),
});

export type MoveOffer = z.input<typeof MoveOfferSchema>;

// An older target leaves out each field it predates, so the source reads a missing one as false.
export const MoveOfferReplySchema = z.object({
  needsImage: z.boolean(),
  needsSystemDrive: z.boolean().default(false),
  storage: z.enum(['xfs', 'zfs']),
  keepsMaxMemory: z.boolean().default(false),
  keepsLeases: z.boolean().default(false),
  keepsPublicEgress: z.boolean().default(false),
  keepsBackupOff: z.boolean().default(false),
});

export type MoveOfferReply = z.infer<typeof MoveOfferReplySchema>;

export const MoveCommitReplySchema = z.object({ isCommitted: z.boolean() });

export type MoveCommitReply = z.infer<typeof MoveCommitReplySchema>;
