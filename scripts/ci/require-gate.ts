import { getStepEnv } from '../lib/get-step-env.ts';
import { GateNeedsSchema, findNewerRunId, pickGateOutcome } from './pick-gate-outcome.ts';
import { readBranchRuns } from './read-branch-runs.ts';

// A required gate: it passes when the jobs it needs passed, and when they were cancelled only if a
// newer run of this workflow on the branch will report the gate in its place.
async function main(): Promise<void> {
  const env = process.env;
  const needs = GateNeedsSchema.parse(JSON.parse(getStepEnv(env, 'NEEDS')));
  const outcome = pickGateOutcome(needs);

  console.log(`require-gate: ${JSON.stringify(needs)}`);

  if (outcome !== 'replaced') {
    console.log(`require-gate: ${outcome}`);

    process.exitCode = outcome === 'pass' ? 0 : 1;

    return;
  }

  const runId = Number(getStepEnv(env, 'GITHUB_RUN_ID'));

  const branchRuns = await readBranchRuns(env, runId);

  const newerRunId = findNewerRunId(branchRuns.runs, branchRuns.run);

  const verdict =
    newerRunId === null
      ? 'a job was cancelled, and no newer run on the branch replaces this one'
      : `a job was cancelled, and run ${String(newerRunId)} on the branch reports this gate`;

  console.log(`require-gate: ${verdict}`);

  process.exitCode = newerRunId === null ? 1 : 0;
}

await main();
