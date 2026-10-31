import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatStepValues } from '../lib/format-step-values.ts';
import { getStepEnv } from '../lib/get-step-env.ts';

const syncCommitPattern =
  /^zgeoff\/tools\/\.github\/workflows\/repo-sync\.yml@(?<commit>[0-9a-f]{40})$/u;

// The repo-sync pull request moves the zgeoff/tools refs in uses lines only, so a job that checks out zgeoff/tools
// reads its ref from repo-sync's uses line instead of keeping a copy that the sync leaves behind.
function main(): void {
  const outputs = getStepEnv(process.env, 'GITHUB_OUTPUT');

  const workflow: unknown = Bun.YAML.parse(
    readFileSync(join('.github', 'workflows', 'repo-sync.yml'), 'utf8'),
  );

  const uses = findSyncUses(workflow);
  const commit = uses === null ? undefined : syncCommitPattern.exec(uses)?.groups?.['commit'];

  if (commit === undefined) {
    console.error(`repo-sync.yml's sync job calls no zgeoff/tools commit: ${String(uses)}`);

    process.exitCode = 1;

    return;
  }

  appendFileSync(outputs, formatStepValues({ ref: commit }));
}

function findSyncUses(workflow: unknown): string | null {
  if (typeof workflow !== 'object' || workflow === null || !('jobs' in workflow)) {
    return null;
  }

  const jobs: unknown = workflow.jobs;

  if (typeof jobs !== 'object' || jobs === null || !('sync' in jobs)) {
    return null;
  }

  const sync: unknown = jobs.sync;

  if (typeof sync !== 'object' || sync === null || !('uses' in sync)) {
    return null;
  }

  return typeof sync.uses === 'string' ? sync.uses : null;
}

if (import.meta.main) {
  main();
}
