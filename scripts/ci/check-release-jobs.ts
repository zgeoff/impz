import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { readLongestPullRequestTimeout } from './read-longest-pull-request-timeout.ts';

const EnvSchema = z.record(z.string(), z.string());

const StepSchema = z.looseObject({
  run: z.string().optional(),
  env: EnvSchema.optional(),
});

const ReleaseJobSchema = z.looseObject({
  needs: z.unknown().optional(),
  uses: z.string().optional(),
  with: z.looseObject({ 'checks-timeout-minutes': z.number().optional() }).optional(),
});

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

export interface ReleaseJobContext {
  readonly syncRef: string;
  readonly longestPullRequestTimeoutMinutes: number;
}

export function collectReleaseJobProblems(
  yaml: string,
  context: Readonly<ReleaseJobContext>,
): string[] {
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

  if (release.uses !== `zgeoff/tools/.github/workflows/release-please.yml@${context.syncRef}`) {
    problems.push(
      `the release job does not call the shared release-please.yml at ${context.syncRef}, the ref repo-sync calls`,
    );
  }

  if ((release.with?.['checks-timeout-minutes'] ?? 0) <= context.longestPullRequestTimeoutMinutes) {
    problems.push(
      `the release job waits no longer for the release PR's checks than a pull request job may run (${String(context.longestPullRequestTimeoutMinutes)} minutes)`,
    );
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

const SyncJobSchema = z.looseObject({ uses: z.string() });
const RepoSyncSchema = z.looseObject({ jobs: z.looseObject({ sync: SyncJobSchema }) });

export function parseSyncRef(yaml: string): string | null {
  const parsed = RepoSyncSchema.safeParse(Bun.YAML.parse(yaml));

  return parsed.success
    ? (/@(?<ref>\S+)$/u.exec(parsed.data.jobs.sync.uses)?.groups?.['ref'] ?? null)
    : null;
}

function main(): void {
  const path = '.github/workflows/ci.yml';
  const syncRef = parseSyncRef(readFileSync('.github/workflows/repo-sync.yml', 'utf8'));

  if (syncRef === null) {
    console.error('.github/workflows/repo-sync.yml: the sync job calls no zgeoff/tools ref');
    process.exit(1);
  }

  const problems = collectReleaseJobProblems(readFileSync(path, 'utf8'), {
    syncRef,
    longestPullRequestTimeoutMinutes: readLongestPullRequestTimeout('.github/workflows'),
  });

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
