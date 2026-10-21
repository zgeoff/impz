import * as z from 'zod';

export const DroppedStorageSchema = z
  .object({
    kind: z.enum(['imp', 'checkpoint', 'image', 'snapshot', 'memory', 'secrets']),
    id: z.string(),
  })
  .readonly();

export type DroppedStorage = z.infer<typeof DroppedStorageSchema>;

export const OrphanStorageSchema = z
  .object({
    kind: z.enum(['imp', 'image', 'memory', 'checkpoint', 'secrets']),
    id: z.string(),

    location: z.string(),

    bytes: z.int().nonnegative(),
    createdAt: z.date().nullable(),

    snapshots: z.array(z.string()).readonly(),

    files: z.array(z.string()).readonly().optional(),
  })
  .readonly();

export type OrphanStorage = z.infer<typeof OrphanStorageSchema>;

export const StorageGcSchema = z
  .object({
    dryRun: z.boolean(),
    dropped: z.array(DroppedStorageSchema).readonly(),
    kept: z.array(OrphanStorageSchema).readonly().optional(),
  })
  .readonly();

export type StorageGc = z.infer<typeof StorageGcSchema>;

// A restore script reads these field names.
export const DatabaseCopySchema = z.object({
  path: z.string(),
  sizeBytes: z.int().nonnegative(),
  lastMigration: z.string(),
  impVersion: z.string(),
  createdAt: z.date(),
  integrity: z.string(),
});
