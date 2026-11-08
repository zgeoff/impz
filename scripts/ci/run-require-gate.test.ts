import { expect, test } from 'bun:test';
import { server } from '@impz/shared/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { runRequireGate } from './run-require-gate';

function setupTest() {
  return {
    env: {
      NEEDS: JSON.stringify({
        'checks-unit': { result: 'cancelled' },
        'checks-lanes': { result: 'success' },
      }),
      GITHUB_RUN_ID: '41',
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_REPOSITORY: 'acme/kiln',
      GH_TOKEN: 'test-token',
    },
  };
}

test.each([
  { title: 'a newer run on the branch replaces', runIDs: [42, 41], exitCode: 0 },
  { title: 'no newer run on the branch replaces', runIDs: [41, 40], exitCode: 1 },
])('it exits $exitCode for a cancelled job that $title', async (row) => {
  const ctx = setupTest();

  server.use(
    http.get('https://api.github.test/repos/acme/kiln/actions/runs/41', () =>
      HttpResponse.json({
        id: 41,
        event: 'pull_request',
        head_repository: { id: 7 },
        pull_requests: [{ number: 5 }],
        workflow_id: 3,
        head_branch: 'glaze/blue',
      }),
    ),
    http.get('https://api.github.test/repos/acme/kiln/actions/workflows/3/runs', () =>
      HttpResponse.json({
        workflow_runs: row.runIDs.map((id) => ({
          id,
          event: 'pull_request',
          head_repository: { id: 7 },
          pull_requests: [{ number: 5 }],
        })),
      }),
    ),
  );

  const exitCode = await runRequireGate(ctx.env);

  expect(exitCode).toBe(row.exitCode);
});
