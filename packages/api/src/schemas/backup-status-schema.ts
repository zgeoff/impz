import * as z from 'zod';
import { ImpSchema } from './imp-schema';

/* @internal */
export const BackupPointSchema = z
  .object({
    id: z.string(),
    time: z.date(),

    imps: z.array(z.string()).readonly(),
  })
  .readonly();

export const BackupStatusSchema = z.object({
  points: z.array(BackupPointSchema).readonly(),
  lastRunAt: z.date().nullable(),
  lastPruneAt: z.date().nullable(),

  lastCheck: z.object({ at: z.date(), error: z.string().optional() }).nullable(),
});

const BackupSkipSchema = z.object({ name: z.string(), reason: z.string() });

export const BackupRunSchema = z.object({
  snapshotId: z.string(),
  imps: z.array(z.string()).readonly(),

  skipped: z.array(BackupSkipSchema).readonly(),

  excluded: z.array(BackupSkipSchema).readonly().optional(),
  dataAddedBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

const SkippedGrantSchema = z.object({ imp: z.string(), secret: z.string(), reason: z.string() });
const NotRestorableSchema = z.object({ imp: z.string(), reason: z.string() });

const RestoredDatabaseSchema = z
  .object({
    tokens: z.array(z.string()).readonly(),
    secrets: z.array(z.string()).readonly(),
    skipped: z.array(BackupSkipSchema).readonly(),
  })
  .readonly();

export const BackupRestoreSchema = z
  .object({
    imps: z.array(ImpSchema).readonly(),
    skippedGrants: z.array(SkippedGrantSchema).readonly(),

    notRestorable: z.array(NotRestorableSchema).readonly().optional(),

    database: RestoredDatabaseSchema.optional(),
  })
  .readonly();

// The forms restic's --read-data-subset takes: n/t, a percentage, or a size such as 2G.
export const BackupCheckSubsetSchema = z
  .string()
  .regex(/^(?:\d+\/\d+|\d+(?:\.\d+)?%|\d+[KMGT]?)$/v);

export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export type BackupRun = z.infer<typeof BackupRunSchema>;

export type BackupRestore = z.infer<typeof BackupRestoreSchema>;
