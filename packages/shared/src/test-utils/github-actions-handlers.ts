import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { HttpResponse, http } from 'msw';
import * as z from 'zod';

export const GITHUB_API_URL = 'https://api.github.test';

// GitHub's docs give this page size for a list that asks for none.
const DEFAULT_PER_PAGE = 30;
const PullRequestSchema = z.object({ number: z.number() });

const RunSchema = z.object({
  id: z.number().default(() => faker.number.int({ min: 1, max: 1_000_000_000 })),
  repository: z.object({ full_name: z.string() }).default(() => ({ full_name: 'acme/kiln' })),
  workflow_id: z.number().default(() => faker.number.int({ min: 1, max: 1000 })),
  head_branch: z.string().default(() => faker.git.branch()),
  event: z.string().default('pull_request'),

  // a deleted fork leaves a run with no head repository
  head_repository: z
    .object({ id: z.number() })
    .nullable()
    .default(() => ({ id: faker.number.int({ min: 1, max: 1_000_000 }) })),

  // GitHub lists no pull request on a fork's run
  pull_requests: z.array(PullRequestSchema).default(() => []),
});

export const githubRuns = new Collection({ schema: RunSchema });

export const githubActionsHandlers = [
  http.get(`${GITHUB_API_URL}/repos/:owner/:repo/actions/runs/:runID`, (info) => {
    const fullName = `${String(info.params['owner'])}/${String(info.params['repo'])}`;
    const runID = Number(info.params['runID']);

    const run = githubRuns
      .findMany((query) => query.where({ id: runID }))
      .find((each) => each.repository.full_name === fullName);

    return run === undefined
      ? HttpResponse.json({ message: 'Not Found', status: '404' }, { status: 404 })
      : HttpResponse.json(run);
  }),

  http.get(`${GITHUB_API_URL}/repos/:owner/:repo/actions/workflows/:workflowID/runs`, (info) => {
    const fullName = `${String(info.params['owner'])}/${String(info.params['repo'])}`;
    const workflowID = Number(info.params['workflowID']);

    const search = new URL(info.request.url).searchParams;

    const branch = search.get('branch');
    const event = search.get('event');
    const perPage = Number(search.get('per_page') ?? DEFAULT_PER_PAGE);

    const runs = githubRuns
      .findMany((query) => query.where({ workflow_id: workflowID }))
      .filter(
        (run) =>
          run.repository.full_name === fullName &&
          (branch === null || run.head_branch === branch) &&
          (event === null || run.event === event),
      )
      .toSorted((left, right) => right.id - left.id);

    return HttpResponse.json({ total_count: runs.length, workflow_runs: runs.slice(0, perPage) });
  }),
];
