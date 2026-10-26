import * as z from 'zod';
import { NameSchema } from './name-schema';

const CountSchema = z.int().nonnegative();
const NameFailureSchema = z.object({ name: NameSchema, error: z.string() });

const TailnetNamesSchema = z.object({
  live: CountSchema,
  failed: z.array(NameFailureSchema).readonly(),
});

const BootStatusSchema = z.object({
  coldBoots: CountSchema,
  outdated: z.object({
    firecracker: CountSchema,
    kernel: CountSchema,
    agent: CountSchema,

    ipv6: CountSchema.optional(),
  }),
});

const PassStatusSchema = z.object({
  isOk: z.boolean(),
  error: z.string().nullable(),
  at: z.date(),
});

const HttpsInfoSchema = z.object({
  domain: z.string(),

  dnsToken: PassStatusSchema.nullable(),
});

const PublicInfoSchema = z.object({
  ip: z.ipv4(),
  imps: CountSchema,

  records: PassStatusSchema.nullable(),
});

const SystemFeaturesSchema = z.object({
  sessionOffsets: z.boolean(),
  leases: z.boolean(),

  grantableTokens: z.boolean().optional(),
  secretRebind: z.boolean().optional(),

  tokenUpdate: z.boolean().optional(),

  tokenImageAdd: z.boolean().optional(),

  databaseCopy: z.boolean().optional(),

  imageOpStream: z.boolean().optional(),

  imageBuilds: z.boolean().optional(),

  execRequire: z.boolean().optional(),

  oauthGrants: z.boolean().optional(),

  secretFilesGc: z.boolean().optional(),

  sessionLog: z.boolean().optional(),

  publicEgress: z.boolean().optional(),

  oauthSecrets: z.boolean().optional(),

  // An impd without this drops a rule's `upstream` unread and sends the
  // credential to https://<host>.
  secretUpstream: z.boolean().optional(),

  secretPresets: z.boolean().optional(),

  // An impd without this drops a create's `backup` unread and backs the imp up.
  backupOptOut: z.boolean().optional(),

  brokerRefusals: z.boolean().optional(),

  // An impd without this drops a grant's `filter` unread and grants the whole
  // host.
  grantFilters: z.boolean().optional(),

  readOnlyFiles: z.boolean().optional(),

  // An impd without this drops an exec's `dropSysAdmin` unread and runs the
  // command with CAP_SYS_ADMIN.
  execDropSysAdmin: z.boolean().optional(),

  guestScratch: z.boolean().optional(),

  imagePins: z.boolean().optional(),

  buildContextUpload: z.boolean().optional(),
});

const GuestInfoSchema = z.object({
  scratchDir: z.string(),
  isClearedOnBoot: z.boolean(),
});

export const SystemInfoSchema = z.object({
  version: z.string(),
  ramBudgetMib: z.int().nonnegative(),

  ramUsedMib: z.int().nonnegative(),

  ramReservedMib: z.int().nonnegative(),

  ramCommittedMib: z.int().nonnegative(),

  ramSleepingMib: z.int().nonnegative().optional(),
  awakeCount: z.int().nonnegative(),
  impCount: z.int().nonnegative(),

  sessionCount: z.int().nonnegative(),

  bootStatus: BootStatusSchema,
  firecrackerVersion: z.string().nullable(),

  guestKernel: z.object({ version: z.string().nullable(), sha256: z.string() }),
  systemDrive: z.object({ sha256: z.string() }),

  guest: GuestInfoSchema.optional(),

  storage: z.object({
    backend: z.enum(['xfs', 'zfs']),
    usedBytes: z.int().nonnegative(),
    availableBytes: z.int().nonnegative(),

    reserveBytes: z.int().nonnegative(),
    pendingBytes: z.int().nonnegative(),
    isLow: z.boolean(),

    impDiskBytes: z.int().nonnegative(),
  }),
  tailscale: z.object({
    enabled: z.boolean(),
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),

    names: TailnetNamesSchema.nullable(),
  }),

  // profitMib is the kernel's general_profit, which goes negative while KSM's
  // metadata outweighs what it merged.
  ksm: z
    .object({
      running: z.boolean(),
      sharedMib: CountSchema,
      profitMib: z.int(),
      zeroMib: CountSchema,
      headroomMib: CountSchema,

      unmergeable: CountSchema,
    })
    .nullable()
    .optional(),

  rebootReason: z.string().nullable().optional(),

  // Outside a private cgroup v2 namespace, CPU limits are kept but not applied.
  cpu: z.object({ hostCpus: z.int().positive(), limitsEnforced: z.boolean() }).optional(),

  defaults: z.object({ memoryMib: z.int().positive(), image: z.string().nullable() }).optional(),

  egress: z.object({ isEnforced: z.boolean() }).optional(),

  public: PublicInfoSchema.nullable().optional(),

  https: HttpsInfoSchema.nullable().optional(),

  features: SystemFeaturesSchema.optional(),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const SystemFeaturesInfoSchema = z.object({
  version: z.string(),
  features: SystemFeaturesSchema,
});

export type SystemFeaturesInfo = z.infer<typeof SystemFeaturesInfoSchema>;

export const SYSTEM_FEATURES = SystemFeaturesSchema.required().parse(
  Object.fromEntries(SystemFeaturesSchema.keyof().options.map((name) => [name, true])),
);
