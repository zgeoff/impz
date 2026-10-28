import * as z from 'zod';

const StepSchema = z.looseObject({
  name: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z
    .looseObject({ name: z.string().optional(), 'write-cache': z.string().optional() })
    .optional(),
});

const MatrixRowSchema = z.looseObject({
  group: z.number(),
  browser: z.boolean(),
  'host-tests': z.boolean(),
});

const MatrixSchema = z.looseObject({ include: z.array(MatrixRowSchema) });

const GroupJobSchema = z.looseObject({
  env: z.looseObject({ WRITE_CACHE: z.string() }),
  strategy: z.looseObject({ 'fail-fast': z.boolean(), matrix: MatrixSchema }),
  steps: z.array(StepSchema),
});

const ShardRowSchema = z.looseObject({
  shard: z.number(),
  lane: z.string().optional(),
  suites: z.string().optional(),
  unit: z.boolean(),
});

const ShardMatrixSchema = z.looseObject({ include: z.array(ShardRowSchema) });

// The shards' build step passes write-cache as a YAML boolean.
const ShardStepWithSchema = z.looseObject({ name: z.string().optional() });
const ShardStepSchema = StepSchema.extend({ with: ShardStepWithSchema.optional() });

const ShardJobSchema = z.looseObject({
  env: z.looseObject({ IMP_ZFS_SHARD: z.string(), IMP_ZFS_E2E_SUITES: z.string() }),
  strategy: z.looseObject({ 'fail-fast': z.boolean(), matrix: ShardMatrixSchema }),
  steps: z.array(ShardStepSchema),
});

const AggregateJobSchema = z.looseObject({
  if: z.string(),
  needs: z.array(z.string()),
  steps: z.array(StepSchema),
});

const ReleaseJobSchema = z.looseObject({
  uses: z.string(),
  with: z.looseObject({ 'checks-timeout-minutes': z.number() }),
});

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({
    'e2e-group': GroupJobSchema,
    e2e: AggregateJobSchema,
    'zfs-shard': ShardJobSchema,
    zfs: AggregateJobSchema,
    release: ReleaseJobSchema,
  }),
});

export type CiJobs = z.infer<typeof WorkflowSchema>['jobs'];

export function parseCiWorkflow(yaml: string): CiJobs {
  return WorkflowSchema.parse(Bun.YAML.parse(yaml)).jobs;
}
