import * as z from 'zod';

const StepSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const ConcurrencySchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

const JobSchema = z.looseObject({
  needs: z.array(z.string()),
  concurrency: ConcurrencySchema.optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
});

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({
    base: JobSchema,
    image: JobSchema,
    publish: JobSchema,
    latest: JobSchema,
    tap: JobSchema,
    'npm-pack': JobSchema,
  }),
});

export type ReleaseJobs = z.infer<typeof WorkflowSchema>['jobs'];

export function parseReleaseWorkflow(yaml: string): ReleaseJobs {
  return WorkflowSchema.parse(Bun.YAML.parse(yaml)).jobs;
}
