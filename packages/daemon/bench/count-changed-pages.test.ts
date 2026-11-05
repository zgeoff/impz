import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'count-changed-pages-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return {
    directory,
    runEntry: (args: readonly string[]) => {
      const result = Bun.spawnSync([
        process.execPath,
        new URL('count-changed-pages.ts', import.meta.url).pathname,
        ...args,
      ]);

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

test('it prints the changed MiB of a snapshot against its base as JSON', async () => {
  const ctx = await setupTest();

  const basePath = join(ctx.directory, 'base.mem');
  const snapshotPath = join(ctx.directory, 'snapshot.mem');

  const snapshot = new Uint8Array(2 * 1024 * 1024);

  snapshot[5000] = 1;

  await writeFile(basePath, new Uint8Array(2 * 1024 * 1024));
  await writeFile(snapshotPath, snapshot);

  expect(ctx.runEntry([basePath, snapshotPath])).toStrictEqual({
    exitCode: 0,
    stdout: '{"changedMib":0.00390625,"changedHugeMib":2}\n',
    stderr: '',
  });
});

test('it exits 2 and names the missing arguments when given none', async () => {
  const ctx = await setupTest();

  expect(ctx.runEntry([])).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr:
      "count-changed-pages: Positional argument 'base' is required; Positional argument 'snapshot' is required\n",
  });
});
