import { readFileSync } from 'node:fs';
import * as z from 'zod';

const EnvSchema = z.record(z.string(), z.string());

const StepSchema = z.looseObject({
  run: z.string().optional(),
  env: EnvSchema.optional(),
});

const ReleaseJobSchema = z.looseObject({ needs: z.unknown().optional() });
const NeedsSchema = z.array(z.string());

const StartReleaseJobSchema = z.looseObject({
  needs: NeedsSchema.optional(),
  if: z.string().optional(),
  steps: z.array(StepSchema),
});

const JobsSchema = z.looseObject({
  release: ReleaseJobSchema,
  'start-release': StartReleaseJobSchema,
});

const WorkflowSchema = z.looseObject({ jobs: JobsSchema });

export function collectReleaseJobProblems(yaml: string): string[] {
  const parsed = WorkflowSchema.safeParse(Bun.YAML.parse(yaml));

  if (!parsed.success) {
    return [`the workflow lacks the release jobs: ${z.prettifyError(parsed.error)}`];
  }

  const release = parsed.data.jobs.release;
  const start = parsed.data.jobs['start-release'];

  const dispatch = start.steps.find(
    (step) => step.run?.includes('gh workflow run release.yml') === true,
  );

  const problems: string[] = [];

  // The App's token cannot tag a merge commit that a workflow change has left behind main's head,
  // so a release job that waits on other jobs gives such a change time to land.
  if (release.needs !== undefined) {
    problems.push('the release job waits on other jobs, so the tag can land after main moves on');
  }

  if (start.needs?.includes('release') !== true) {
    problems.push('the start-release job does not wait on the release job');
  }

  if (start.if !== `needs.release.outputs.releases_created == 'true'`) {
    problems.push(
      `the start-release job does not run on the release job's releases_created output`,
    );
  }

  if (dispatch === undefined) {
    problems.push('the start-release job starts no release.yml run');
  } else if (dispatch.env?.['TAG'] !== `\${{ needs.release.outputs.tag }}`) {
    problems.push(`the start-release job does not pass the release job's tag output as TAG`);
  }

  return problems;
}

function main(): void {
  const path = '.github/workflows/ci.yml';
  const problems = collectReleaseJobProblems(readFileSync(path, 'utf8'));

  for (const problem of problems) {
    console.error(`${path}: ${problem}`);
  }

  if (problems.length > 0) {
    process.exit(1);
  }

  console.log('check-release-jobs: the release jobs tag at merge and start the release');
}

if (import.meta.main) {
  main();
}
