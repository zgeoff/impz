import { faker } from '@faker-js/faker';
import { NameSchema, SystemInfoSchema } from '@impz/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const info = SystemInfoSchema.shape;

const HostRowSchema = z.object({
  version: z.string().default(() => faker.system.semver()),
  ramBudgetMib: z
    .int()
    .nonnegative()
    .default(() => faker.number.int({ min: 4, max: 64 }) * 1024),
  ramReservedMib: z.int().nonnegative().default(0),
  firecrackerVersion: info.firecrackerVersion.default(() => `v${faker.system.semver()}`),
  guestKernel: info.guestKernel.default(() => ({
    version: null,
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  systemDrive: info.systemDrive.default(() => ({
    sha256: faker.string.hexadecimal({ length: 64, prefix: '' }),
  })),
  backend: info.storage.shape.backend.default('xfs'),
  disk: info.storage.omit({ backend: true, impDiskBytes: true }).default(() => ({
    usedBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    availableBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
    reserveBytes: faker.number.int({ min: 0, max: 1024 ** 3 }),
    pendingBytes: 0,
    isLow: false,
  })),
  tailscale: info.tailscale.default(() => ({
    enabled: false,
    state: null,
    hostname: null,
    ip: null,
    names: null,
  })),
  cpu: z
    .object({ hostCpus: z.int().positive(), limitsEnforced: z.boolean() })
    .default(() => ({ hostCpus: faker.number.int({ min: 2, max: 64 }), limitsEnforced: true })),
  defaultImage: NameSchema.default('base'),
  defaultMemoryMib: z.int().positive().default(2048),
  defaultVcpus: z.int().positive().default(2),
  isEgressEnforced: z.boolean().default(true),
  ksm: z
    .object({
      running: z.boolean(),
      sharedMib: z.int().nonnegative(),
      profitMib: z.int(),
      zeroMib: z.int().nonnegative(),
      headroomMib: z.int().nonnegative(),
    })
    .nullable()
    .default(null),
  publicIp: z.ipv4().nullable().default(null),
  publicRecords: z
    .object({ isOk: z.boolean(), error: z.string().nullable(), at: z.date() })
    .nullable()
    .default(null),
  https: info.https.unwrap().default(null),
  rebootReason: z.string().nullable().default(null),
});

export const hostCollection = new Collection({ schema: HostRowSchema });
