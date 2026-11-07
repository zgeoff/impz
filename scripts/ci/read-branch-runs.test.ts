import { expect, test } from 'bun:test';
import { server } from '@impz/shared/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { readBranchRuns } from './read-branch-runs';

function setupTest() {
  return {
    env: {
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_REPOSITORY: 'acme/kiln',
      GH_TOKEN: 'test-token',
    },
  };
}

test('it reads the run and the runs of its workflow on its branch', async () => {
  const ctx = setupTest();

  server.use(
    http.get('https://api.github.test/repos/acme/kiln/actions/runs/41', () =>
      HttpResponse.json({
        id: 41,
        event: 'pull_request',
        head_repository: { id: 7 },
        workflow_id: 3,
        head_branch: 'glaze/blue',
      }),
    ),
    http.get('https://api.github.test/repos/acme/kiln/actions/workflows/3/runs', () =>
      HttpResponse.json({
        workflow_runs: [
          { id: 42, event: 'pull_request', head_repository: { id: 7 } },
          { id: 40, event: 'pull_request', head_repository: null },
        ],
      }),
    ),
  );

  const branchRuns = await readBranchRuns(ctx.env, 41);

  expect(branchRuns).toStrictEqual({
    run: { id: 41, event: 'pull_request', headRepositoryID: 7 },
    runs: [
      { id: 42, event: 'pull_request', headRepositoryID: 7 },
      { id: 40, event: 'pull_request', headRepositoryID: null },
    ],
  });
});

test('it asks for the runs of the same event on the branch of the run', async () => {
  const ctx = setupTest();
  const requested: string[] = [];

  server.use(
    http.get('https://api.github.test/repos/acme/kiln/actions/runs/41', () =>
      HttpResponse.json({
        id: 41,
        event: 'pull_request',
        head_repository: { id: 7 },
        workflow_id: 3,
        head_branch: 'glaze/blue',
      }),
    ),
    http.get('https://api.github.test/repos/acme/kiln/actions/workflows/3/runs', (info) => {
      requested.push(info.request.url);

      return HttpResponse.json({ workflow_runs: [] });
    }),
  );

  await readBranchRuns(ctx.env, 41);

  expect(requested).toStrictEqual([
    'https://api.github.test/repos/acme/kiln/actions/workflows/3/runs?branch=glaze%2Fblue&event=pull_request&per_page=20',
  ]);
});

test('it fails with the URL, status and body when GitHub refuses a request', () => {
  const ctx = setupTest();

  server.use(
    http.get('https://api.github.test/repos/acme/kiln/actions/runs/41', () =>
      HttpResponse.text('Resource not accessible by integration', { status: 403 }),
    ),
  );

  expect(readBranchRuns(ctx.env, 41)).rejects.toThrowWithMessage(
    Error,
    'GET https://api.github.test/repos/acme/kiln/actions/runs/41 answered 403: Resource not accessible by integration',
  );
});
