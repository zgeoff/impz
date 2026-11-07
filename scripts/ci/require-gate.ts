import * as z from 'zod';
import { getStepEnv } from '../lib/get-step-env.ts';
import { GateNeedsSchema, isRunReplaced, pickGateOutcome } from './pick-gate-outcome.ts';

const RunSchema = z.looseObject({ workflow_id: z.number(), head_branch: z.string() });
const RunIdSchema = z.looseObject({ id: z.number() });
const RunsSchema = z.looseObject({ workflow_runs: z.array(RunIdSchema) });

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

  const runIds = await readBranchRunIds(env, runId);

  const isReplaced = isRunReplaced(runIds, runId);

  const verdict = isReplaced
    ? 'a job was cancelled, and a newer run on the branch reports this gate'
    : 'a job was cancelled, and no newer run on the branch replaces this one';

  console.log(`require-gate: ${verdict}`);

  process.exitCode = isReplaced ? 0 : 1;
}

async function readBranchRunIds(
  env: Readonly<Record<string, string | undefined>>,
  runId: number,
): Promise<number[]> {
  const api = `${getStepEnv(env, 'GITHUB_API_URL')}/repos/${getStepEnv(env, 'GITHUB_REPOSITORY')}`;

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${getStepEnv(env, 'GH_TOKEN')}`,
  };

  const runResponse = await fetch(`${api}/actions/runs/${String(runId)}`, { headers });
  const runBody: unknown = await runResponse.json();

  const run = RunSchema.parse(runBody);
  const branch = encodeURIComponent(run.head_branch);

  const runsResponse = await fetch(
    `${api}/actions/workflows/${String(run.workflow_id)}/runs?branch=${branch}&per_page=20`,
    { headers },
  );

  const runsBody: unknown = await runsResponse.json();

  return RunsSchema.parse(runsBody).workflow_runs.map((each) => each.id);
}

await main();
