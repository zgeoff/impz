import { expect, test } from 'bun:test';
import { GITHUB_API_URL, githubRuns } from './github-actions-api';

function setupTest() {
  return {
    read: async (path: string) => {
      const response = await fetch(`${GITHUB_API_URL}${path}`);
      const body: unknown = await response.json();

      return { status: response.status, body };
    },
  };
}

test('it answers a seeded run', async () => {
  const ctx = setupTest();

  await githubRuns.create({ id: 41, workflow_id: 3, head_branch: 'glaze/blue' });

  const answer = await ctx.read('/repos/acme/kiln/actions/runs/41');

  expect(answer).toStrictEqual({
    status: 200,
    body: expect.objectContaining({ id: 41, workflow_id: 3, head_branch: 'glaze/blue' }),
  });
});

test('it answers 404 for a run it does not hold', async () => {
  const ctx = setupTest();

  await githubRuns.create({ id: 41 });

  const answer = await ctx.read('/repos/acme/kiln/actions/runs/42');

  expect(answer).toStrictEqual({ status: 404, body: { message: 'Not Found', status: '404' } });
});

test('it lists a workflow’s runs on a branch from one event, newest first', async () => {
  const ctx = setupTest();

  await githubRuns.create({ id: 40, workflow_id: 3, head_branch: 'glaze/blue' });
  await githubRuns.create({ id: 42, workflow_id: 3, head_branch: 'glaze/blue' });
  await githubRuns.create({ id: 43, workflow_id: 3, head_branch: 'glaze/red' });
  await githubRuns.create({ id: 44, workflow_id: 3, head_branch: 'glaze/blue', event: 'push' });
  await githubRuns.create({ id: 45, workflow_id: 8, head_branch: 'glaze/blue' });

  const answer = await ctx.read(
    '/repos/acme/kiln/actions/workflows/3/runs?branch=glaze%2Fblue&event=pull_request',
  );

  expect(answer).toStrictEqual({
    status: 200,
    body: {
      total_count: 2,
      workflow_runs: [expect.objectContaining({ id: 42 }), expect.objectContaining({ id: 40 })],
    },
  });
});

test('it lists no more runs than a page holds', async () => {
  const ctx = setupTest();

  await githubRuns.create({ id: 40, workflow_id: 3 });
  await githubRuns.create({ id: 41, workflow_id: 3 });

  const answer = await ctx.read('/repos/acme/kiln/actions/workflows/3/runs?per_page=1');

  expect(answer).toStrictEqual({
    status: 200,
    body: { total_count: 2, workflow_runs: [expect.objectContaining({ id: 41 })] },
  });
});
