import * as z from 'zod';
import { CheckpointRefSchema } from '../schemas/checkpoint-ref-schema';
import { CpuLimitSchema } from '../schemas/cpu-limit-schema';
import { CpuWeightSchema } from '../schemas/cpu-weight-schema';
import { EgressPolicySchema } from '../schemas/egress-schema';
import { EmptySchema } from '../schemas/empty-schema';
import { ExposeInputSchema, ExposeResultSchema } from '../schemas/exposure-schema';
import { ImpCreateInputSchema } from '../schemas/imp-create-input-schema';
import { ForkResultSchema, ImpSchema } from '../schemas/imp-schema';
import { NameInputSchema } from '../schemas/name-input-schema';
import { NameSchema } from '../schemas/name-schema';
import { PortSchema } from '../schemas/port-schema';
import { VcpusSchema } from '../schemas/vcpus-schema';
import { ACCESS } from './access';
import { contractBase as base } from './contract-base';

const ForceInputSchema = z.object({ name: NameSchema, force: z.boolean().optional() });

export const impsContract = {
  create: base.meta(ACCESS.manageImp).input(ImpCreateInputSchema).output(ImpSchema),

  list: base
    .meta(ACCESS.readAny)
    .input(z.object({ builders: z.boolean().optional() }).optional())
    .output(z.array(ImpSchema)),

  get: base.meta(ACCESS.readImp).input(NameInputSchema).output(ImpSchema),

  destroy: base.meta(ACCESS.manageImp).input(NameInputSchema).output(EmptySchema),

  start: base.meta(ACCESS.execImp).input(NameInputSchema).output(ImpSchema),

  stop: base.meta(ACCESS.execImp).input(ForceInputSchema).output(ImpSchema),

  sleep: base.meta(ACCESS.execImp).input(ForceInputSchema).output(ImpSchema),

  wake: base
    .meta(ACCESS.execImp)
    .input(z.object({ name: NameSchema, restartError: z.boolean().optional() }))
    .output(ImpSchema),

  hold: base
    .meta(ACCESS.execImp)
    .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
    .output(ImpSchema),

  // a bigger disk spends the host's disk budget, as a create does
  resizeDisk: base
    .meta(ACCESS.manageImp)
    .input(z.object({ name: NameSchema, diskMib: z.int().min(1024) }))
    .output(ImpSchema),

  url: base
    .meta(ACCESS.readImp)
    .input(NameInputSchema)
    .output(
      z.object({
        local: z.url(),
        https: z.url().nullable(),

        public: z.url().nullable(),

        service: z.url().nullable(),
        tailnet: z.url().nullable(),
      }),
    ),

  policy: base.meta(ACCESS.readImp).input(NameInputSchema).output(EgressPolicySchema),

  setPolicy: base
    .meta(ACCESS.manageImp)
    .input(z.object({ name: NameSchema, policy: EgressPolicySchema }))
    .output(EgressPolicySchema),

  // who reaches an imp from the internet is the host's call, either way: a
  // token for one imp must not publish it, nor change what another set up
  expose: base.meta(ACCESS.manageHost).input(ExposeInputSchema).output(ExposeResultSchema),

  unexpose: base.meta(ACCESS.manageHost).input(NameInputSchema).output(ImpSchema),

  fork: base
    .meta({ access: { scope: 'manage', on: 'imp', fields: ['source', 'name'], noGrantable: true } })
    .input(
      z.object({
        source: NameSchema,
        name: NameSchema,
        checkpoint: CheckpointRefSchema.optional(),
      }),
    )
    .output(ForkResultSchema),

  // a CPU limit or weight takes from, or gives back to, the other imps, and
  // a new HTTP port moves the imp's URL to another service
  update: base
    .meta(ACCESS.manageImp)
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
