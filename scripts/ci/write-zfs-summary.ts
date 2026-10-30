import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStepEnv } from '../lib/get-step-env.ts';

// The zfs host test writes its summary after a failed suite too, and a run that stops before the
// summary, or before the step that picks its work dir, still gets a job summary that says so.
function main(): void {
  const zfsDir = process.env['IMP_ZFS_TEST_DIR'];
  const summary = zfsDir === undefined ? undefined : join(zfsDir, 'summary.txt');
  const stepSummary = getStepEnv(process.env, 'GITHUB_STEP_SUMMARY');

  const timings =
    summary !== undefined && existsSync(summary)
      ? readFileSync(summary, 'utf8')
      : 'no summary: the run stopped before it\n';

  appendFileSync(
    stepSummary,
    [
      'Nested KVM on a shared runner, a pool in a sparse file and a 1 GiB ARC: these',
      'numbers do not compare directly with XFS ones.',
      '',
      '```text',
      timings.trimEnd(),
      '```',
      '',
    ].join('\n'),
  );
}

if (import.meta.main) {
  main();
}
