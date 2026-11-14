import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/shared/test-utils/wait-for';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'run-local-impd-'));

  const temp = join(root, 'tmp');
  const runDirectory = join(root, 'run');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  await mkdir(temp);
  await mkdir(runDirectory);

  return {
    temp,
    startApp: () =>
      Bun.spawn([process.execPath, join(import.meta.dir, 'run-local-impd.ts')], {
        env: {
          ...process.env,
          TMPDIR: temp,
          IMPZ_VERIFY_RUN_DIRECTORY: runDirectory,
          IMPZ_VERIFY_SERVICE_DIGEST: 'ab'.repeat(32),
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
  };
}

test('it removes the harness folders of impd when a stop comes before it is ready', async () => {
  const ctx = await setupTest();

  const app = ctx.startApp();

  onTestFinished(() => {
    app.kill('SIGKILL');
  });

  await waitFor(async () => {
    const entries = await readdir(ctx.temp);

    if (!entries.some((entry) => entry.includes('impd-test-'))) {
      throw new Error('impd has made no data folder yet');
    }
  });

  app.kill('SIGTERM');

  await app.exited;

  const left = await readdir(ctx.temp);

  expect(left).toStrictEqual([]);
});
