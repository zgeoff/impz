import * as z from 'zod';
import { CpuLimitSchema } from './cpu-limit-schema';
import { CpuWeightSchema } from './cpu-weight-schema';
import { EgressPolicySchema } from './egress-schema';
import { NameSchema } from './name-schema';
import { MAX_CREATE_NETWORKS } from './network-schema';
import { PortSchema } from './port-schema';
import { VcpusSchema } from './vcpus-schema';

// imps.create's input, which the MCP tool imp_create picks its fields from
export const ImpCreateInputSchema = z.object({
  name: NameSchema.optional(),
  image: NameSchema.optional(),
  vcpus: VcpusSchema.optional(),
  memoryMib: z.int().min(128).optional(),

  // what the guest may grow to under memory pressure, at most 4 ×
  // memoryMib; memoryMib by default, which never grows
  maxMemoryMib: z.int().min(128).optional(),

  // at least the image's filesystem; IMP_DEFAULT_DISK_GIB by default
  diskMib: z.int().min(1024).optional(),

  // the guest port the wake proxy forwards HTTP to (default 8080)
  httpPort: PortSchema.optional(),

  // what the imp may reach directly (default open)
  policy: EgressPolicySchema.optional(),

  // null, the default, is no limit
  cpuLimit: CpuLimitSchema.nullable().optional(),
  cpuWeight: CpuWeightSchema.optional(),

  // networks it joins, which must exist; host-wide callers only
  networks: z.array(NameSchema).max(MAX_CREATE_NETWORKS).optional(),

  // false leaves the imp's disk and checkpoints out of every backup
  // run, for its life (default true); an impd without
  // features.backupOptOut ignores it, so check that first
  backup: z.boolean().optional(),
});
