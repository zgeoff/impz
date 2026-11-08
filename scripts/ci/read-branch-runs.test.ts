import { expect, test } from 'bun:test';
import { GITHUB_API_URL, githubRuns } from '@impz/shared/test-utils/github-actions-api';
import { server } from '@impz/shared/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { readBranchRuns } from './read-branch-runs';

function setupTest() {
  return {
    env: { GITHUB_API_URL, GITHUB_REPOSITORY: 'acme/kiln', GH_TOKEN: 'test-token' },
  };
}

test('it reads the run and the runs of its workflow from the same event on its branch', async () => {
  const ctx = setupTest();

  await githubRuns.create({
    id: 41,
    workflow_id: 3,
    head_branch: 'glaze/blue',
    head_repository: { id: 7 },
    pull_requests: [{ number: 5 }],
  });

  await githubRuns.create({
    id: 42,
    workflow_id: 3,
    head_branch: 'glaze/blue',
    head_repository: { id: 7 },
    pull_requests: [{ number: 5 }],
  });

  await githubRuns.create({
    id: 40,
    workflow_id: 3,
    head_branch: 'glaze/blue',
    head_repository: null,
  });

  await githubRuns.create({ id: 43, workflow_id: 3, head_branch: 'glaze/red' });
  await githubRuns.create({ id: 44, workflow_id: 3, head_branch: 'glaze/blue', event: 'push' });

  const branchRuns = await readBranchRuns(ctx.env, 41);

  expect(branchRuns).toStrictEqual({
    run: { id: 41, event: 'pull_request', headRepositoryID: 7, pullRequestNumbers: [5] },
    runs: [
      { id: 42, event: 'pull_request', headRepositoryID: 7, pullRequestNumbers: [5] },
      { id: 41, event: 'pull_request', headRepositoryID: 7, pullRequestNumbers: [5] },
      { id: 40, event: 'pull_request', headRepositoryID: null, pullRequestNumbers: [] },
    ],
  });
});

test('it fails with the URL, status and body when GitHub refuses a request', () => {
  const ctx = setupTest();

  server.use(
    http.get(`${GITHUB_API_URL}/repos/acme/kiln/actions/runs/41`, () =>
      HttpResponse.text('Resource not accessible by integration', { status: 403 }),
    ),
  );

  expect(readBranchRuns(ctx.env, 41)).rejects.toThrowWithMessage(
    Error,
    'GET https://api.github.test/repos/acme/kiln/actions/runs/41 answered 403: Resource not accessible by integration',
  );
});
