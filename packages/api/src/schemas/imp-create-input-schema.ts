import * as z from 'zod';
import { CpuLimitSchema } from './cpu-limit-schema';
import { CpuWeightSchema } from './cpu-weight-schema';
import { EgressPolicySchema } from './egress-schema';
import { NameSchema } from './name-schema';
import { MAX_CREATE_NETWORKS } from './network-schema';
import { PortSchema } from './port-schema';
import { VcpusSchema } from './vcpus-schema';

export const ImpCreateInputSchema = z.object({
  name: NameSchema.optional(),
  image: NameSchema.optional(),
  vcpus: VcpusSchema.optional(),
  memoryMib: z.int().min(128).optional(),

  maxMemoryMib: z.int().min(128).optional(),

  diskMib: z.int().min(1024).optional(),

  httpPort: PortSchema.optional(),

  policy: EgressPolicySchema.optional(),

  cpuLimit: CpuLimitSchema.nullable().optional(),
  cpuWeight: CpuWeightSchema.optional(),

  networks: z.array(NameSchema).max(MAX_CREATE_NETWORKS).optional(),

  backup: z.boolean().optional(),
});
