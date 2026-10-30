// oxlint-disable-next-line zgeoff/test-beside-module -- it tests .github/workflows/release.yml, and bun test never searches .github/ for a test beside it
import { expect, test } from 'bun:test';

// actionlint ignores the queue key (.github/actionlint.yaml), and the shared workflow lint does not
// read it, so this test is the one check on the lock that the move of `latest` relies on.
test('it holds the latest job under one queued group that every release run shares', async () => {
  const text = await Bun.file(
    new URL('../../.github/workflows/release.yml', import.meta.url),
  ).text();

  const workflow: unknown = Bun.YAML.parse(text);

  expect(workflow).toMatchObject({
    jobs: {
      latest: { concurrency: { group: 'latest-tag', 'cancel-in-progress': false, queue: 'max' } },
    },
  });
});
