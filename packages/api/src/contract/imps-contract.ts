import { oc } from '@orpc/contract';
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
import { IMP_ERRORS } from './imp-errors';

const base = oc.errors(IMP_ERRORS);
const ForceInputSchema = z.object({ name: NameSchema, force: z.boolean().optional() });

export const impsContract = {
  create: base.input(ImpCreateInputSchema).output(ImpSchema),

  list: base
    .input(z.object({ builders: z.boolean().optional() }).optional())
    .output(z.array(ImpSchema)),

  get: base.input(NameInputSchema).output(ImpSchema),

  destroy: base.input(NameInputSchema).output(EmptySchema),

  start: base.input(NameInputSchema).output(ImpSchema),

  stop: base.input(ForceInputSchema).output(ImpSchema),

  sleep: base.input(ForceInputSchema).output(ImpSchema),

  wake: base
    .input(z.object({ name: NameSchema, restartError: z.boolean().optional() }))
    .output(ImpSchema),

  hold: base
    .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
    .output(ImpSchema),

  resizeDisk: base
    .input(z.object({ name: NameSchema, diskMib: z.int().min(1024) }))
    .output(ImpSchema),

  url: base.input(NameInputSchema).output(
    z.object({
      local: z.url(),
      https: z.url().nullable(),

      public: z.url().nullable(),

      service: z.url().nullable(),
      tailnet: z.url().nullable(),
    }),
  ),

  policy: base.input(NameInputSchema).output(EgressPolicySchema),

  setPolicy: base
    .input(z.object({ name: NameSchema, policy: EgressPolicySchema }))
    .output(EgressPolicySchema),

  expose: base.input(ExposeInputSchema).output(ExposeResultSchema),

  unexpose: base.input(NameInputSchema).output(ImpSchema),

  fork: base
    .input(
      z.object({
        source: NameSchema,
        name: NameSchema,
        checkpoint: CheckpointRefSchema.optional(),
      }),
    )
    .output(ForkResultSchema),

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
