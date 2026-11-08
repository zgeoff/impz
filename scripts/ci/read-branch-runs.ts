import * as z from 'zod';
import { getStepEnv } from '../lib/get-step-env.ts';
import type { GateRun } from './pick-gate-outcome.ts';

const PullRequestSchema = z.looseObject({ number: z.number() });

// A deleted fork leaves a run with no head repository.
const RunSchema = z.looseObject({
  id: z.number(),
  event: z.string(),
  head_repository: z.looseObject({ id: z.number() }).nullable(),
  pull_requests: z.array(PullRequestSchema),
});

const RunsSchema = z.looseObject({ workflow_runs: z.array(RunSchema) });
const BranchRunSchema = RunSchema.extend({ workflow_id: z.number(), head_branch: z.string() });

export interface BranchRuns {
  readonly run: GateRun;
  readonly runs: readonly GateRun[];
}

export async function readBranchRuns(
  env: Readonly<Record<string, string | undefined>>,
  runID: number,
): Promise<BranchRuns> {
  const api = `${getStepEnv(env, 'GITHUB_API_URL')}/repos/${getStepEnv(env, 'GITHUB_REPOSITORY')}`;

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${getStepEnv(env, 'GH_TOKEN')}`,
  };

  const runBody = await readJSON(`${api}/actions/runs/${String(runID)}`, headers);

  const run = BranchRunSchema.parse(runBody);
  const branch = encodeURIComponent(run.head_branch);
  const event = encodeURIComponent(run.event);

  const runsBody = await readJSON(
    `${api}/actions/workflows/${String(run.workflow_id)}/runs?branch=${branch}&event=${event}&per_page=20`,
    headers,
  );

  return { run: toGateRun(run), runs: RunsSchema.parse(runsBody).workflow_runs.map(toGateRun) };
}

async function readJSON(url: string, headers: Readonly<Record<string, string>>): Promise<unknown> {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(`GET ${url} answered ${String(response.status)}: ${text}`);
  }

  const body: unknown = await response.json();

  return body;
}

function toGateRun(run: Readonly<z.infer<typeof RunSchema>>): GateRun {
  return {
    id: run.id,
    event: run.event,
    headRepositoryID: run.head_repository?.id ?? null,
    pullRequestNumbers: run.pull_requests.map((pullRequest) => pullRequest.number),
  };
}
