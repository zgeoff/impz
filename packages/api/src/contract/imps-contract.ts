import { oc } from '@orpc/contract';
import * as z from 'zod';
import { CheckpointRefSchema } from '../schemas/checkpoint-schema';
import { EgressPolicySchema } from '../schemas/egress-schema';
import { EmptySchema } from '../schemas/empty-schema';
import { ExposeInputSchema, ExposeResultSchema } from '../schemas/exposure-schema';
import { ForkResultSchema, ImpSchema } from '../schemas/imp-schema';
import { NameInputSchema, NameSchema } from '../schemas/name-schema';
import { MAX_CREATE_NETWORKS } from '../schemas/network-schema';
import { IMP_ERRORS } from './imp-errors';

const base = oc.errors(IMP_ERRORS);

// a sleep or stop that ends the imp's leases rather than fail with LEASED
const ForceInputSchema = z.object({ name: NameSchema, force: z.boolean().optional() });

// cores; below 0.1 the VMM thread starves and a boot times out. impd also
// refuses more than the host has.
const CpuLimitSchema = z.number().min(0.1);

// the guest's cores, which the host's limit then shares out
const VcpusSchema = z.int().min(1).max(32);

// a TCP port in the guest
const PortSchema = z.int().min(1).max(65_535);

// cgroup v2 cpu.weight; 100 is the default share
const CpuWeightSchema = z.int().min(1).max(10_000);

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

export const impsContract = {
  create: base.input(ImpCreateInputSchema).output(ImpSchema),

  // image builders only with `builders`; an impd from before them
  // ignores it
  list: base
    .input(z.object({ builders: z.boolean().optional() }).optional())
    .output(z.array(ImpSchema)),

  get: base.input(NameInputSchema).output(ImpSchema),

  destroy: base.input(NameInputSchema).output(EmptySchema),

  // cold boot of a stopped imp; a running imp is returned as it is
  start: base.input(NameInputSchema).output(ImpSchema),

  // agent shutdown, then SIGKILL after a timeout; memory is lost. LEASED
  // on an imp with a lease from `leases.*`, unless `force` ends them.
  stop: base.input(ForceInputSchema).output(ImpSchema),

  // LEASED as for stop
  sleep: base.input(ForceInputSchema).output(ImpSchema),

  // restartError: false refuses an imp in error with INVALID_STATE instead
  // of booting it again
  wake: base
    .input(z.object({ name: NameSchema, restartError: z.boolean().optional() }))
    .output(ImpSchema),

  // the caller's lease labelled `hold`, which never blocks a sleep or a
  // stop; seconds = 0 releases it and a hold from before leases
  hold: base
    .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
    .output(ImpSchema),

  // grows the disk; a running guest grows its filesystem at once, a
  // sleeping one when it wakes, a stopped one when it boots
  resizeDisk: base
    .input(z.object({ name: NameSchema, diskMib: z.int().min(1024) }))
    .output(ImpSchema),

  url: base.input(NameInputSchema).output(
    z.object({
      local: z.url(),
      https: z.url().nullable(),

      // https://<name>.<domain> from the internet, while the imp is public
      public: z.url().nullable(),

      // the imp's own name on the tailnet, once impd serves it
      service: z.url().nullable(),
      tailnet: z.url().nullable(),
    }),
  ),

  // the egress policy; a change applies at once, whatever the imp's state
  policy: base.input(NameInputSchema).output(EgressPolicySchema),

  setPolicy: base
    .input(z.object({ name: NameSchema, policy: EgressPolicySchema }))
    .output(EgressPolicySchema),

  // serves the imp to the internet at https://<name>.<domain>; an imp
  // already public gets a new credential. PRECONDITION_FAILED without
  // IMP_PUBLIC_IP.
  expose: base.input(ExposeInputSchema).output(ExposeResultSchema),

  // back to the tailnet only, at once
  unexpose: base.input(NameInputSchema).output(ImpSchema),

  // disk only, with the source's egress policy, and the source's grants
  // the caller could make; CONFLICT when the source goes, or another imp
  // takes its name, before the disk copy
  fork: base
    .input(
      z.object({
        source: NameSchema,
        name: NameSchema,
        checkpoint: CheckpointRefSchema.optional(),
      }),
    )
    .output(ForkResultSchema),

  // a running VM takes a new CPU limit or weight at once, a sleeping or
  // stopped one when it next starts; vcpus only while stopped. A null
  // cpuLimit removes the limit. httpPort applies to the next request.
  update: base
    .input(
      z.object({
        name: NameSchema,
        cpuLimit: CpuLimitSchema.nullable().optional(),
        cpuWeight: CpuWeightSchema.optional(),
        vcpus: VcpusSchema.optional(),
        httpPort: PortSchema.optional(),
      }),
    )
    .output(ImpSchema),
};
