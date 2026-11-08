import { expect, test } from 'bun:test';
import { GITHUB_API_URL, githubRuns } from '@impz/shared/test-utils/github-actions-api';
import { runRequireGate } from './run-require-gate';

function setupTest() {
  return {
    env: {
      NEEDS: JSON.stringify({
        'checks-unit': { result: 'cancelled' },
        'checks-lanes': { result: 'success' },
      }),
      GITHUB_RUN_ID: '41',
      GITHUB_API_URL,
      GITHUB_REPOSITORY: 'acme/kiln',
      GH_TOKEN: 'test-token',
    },
  };
}

test.each([
  { title: 'a newer run of the same pull request replaces', newerPullRequest: 5, exitCode: 0 },
  {
    title: 'only a newer run of another pull request from the branch follows',
    newerPullRequest: 6,
    exitCode: 1,
  },
])('it exits $exitCode for a cancelled job that $title', async (row) => {
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
    pull_requests: [{ number: row.newerPullRequest }],
  });

  const exitCode = await runRequireGate(ctx.env);

  expect(exitCode).toBe(row.exitCode);
});

test('it exits 1 for a cancelled job with no newer run on the branch', async () => {
  const ctx = setupTest();

  await githubRuns.create({
    id: 41,
    workflow_id: 3,
    head_branch: 'glaze/blue',
    head_repository: { id: 7 },
    pull_requests: [{ number: 5 }],
  });

  const exitCode = await runRequireGate(ctx.env);

  expect(exitCode).toBe(1);
});
