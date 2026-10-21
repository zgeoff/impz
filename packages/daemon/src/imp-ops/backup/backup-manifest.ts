import { GrantFilterSchema, ImageSourceSchema } from '@impz/api';
import * as z from 'zod';
import { LEGACY_DISK_BYTES } from '../../platform/process/legacy-disk-bytes';

const ManifestCheckpointSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    createdAt: z.coerce.date(),
    disk: z.string(),

    diskBytes: z.int().positive().default(LEGACY_DISK_BYTES),
    usedBytes: z.int().nonnegative().optional(),
  })
  .readonly();

const FilteredGrantSchema = z.object({ secret: z.string(), filter: GrantFilterSchema }).readonly();

const ManifestImpSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    imageDigest: z.string(),
    vcpus: z.int(),
    memoryMib: z.int(),
    maxMemoryMib: z.int().nullable().optional(),
    httpPort: z.int(),
    state: z.string(),
    synced: z.boolean(),

    // oxlint-disable-next-line zgeoff/no-abbreviated-names -- stored backups hold this key
    dir: z.string(),
    disk: z.string(),

    diskBytes: z.int().positive().default(LEGACY_DISK_BYTES),
    usedBytes: z.int().nonnegative().optional(),
    egressPolicy: z.string().default('open'),
    egressAllow: z.array(z.string()).readonly().default([]),
    grants: z.array(z.string()).readonly().default([]),

    // Kept apart from the plain grants, so an impd that predates filters
    // restores none of them rather than grant the whole host.
    filteredGrants: z.array(FilteredGrantSchema).readonly().default([]),
    identityResetPending: z.boolean().default(false),
    networks: z.array(z.string()).readonly().default([]),

    checkpoints: z.array(ManifestCheckpointSchema).readonly(),
  })
  .readonly();

const ManifestImageSchema = z
  .object({
    name: z.string(),
    ref: z.string(),
    digest: z.string(),
    source: ImageSourceSchema.default('oci'),
    sourceImp: z.string().nullable().default(null),
    sizeBytes: z.int(),

    // oxlint-disable-next-line zgeoff/no-abbreviated-names -- stored backups hold this key
    dir: z.string(),
  })
  .readonly();

const ManifestExcludedSchema = z.object({ name: z.string(), reason: z.string() }).readonly();

export const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    createdAt: z.coerce.date(),
    imps: z.array(ManifestImpSchema).readonly(),
    excluded: z.array(ManifestExcludedSchema).readonly().default([]),
    images: z.array(ManifestImageSchema).readonly(),
    database: z
      .object({ file: z.string(), sizeBytes: z.int().nonnegative() })
      .readonly()
      .nullable()
      .default(null),
  })
  .readonly();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export type ManifestImp = z.infer<typeof ManifestImpSchema>;

export type ManifestImage = z.infer<typeof ManifestImageSchema>;
