import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevLock } from './create-dev-lock';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'dev-lock-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory };
}

test('it refuses a second lock on a dev instance while the first holds it', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.directory, 'imp-bench');

  expect(() => createDevLock(ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `process ${String(process.pid)} holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it locks a dev instance again once the last lock was released', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.directory, 'imp-bench').release();

  expect(() => createDevLock(ctx.directory, 'imp-bench')).not.toThrow();
});

test('it locks two dev instances of different names at once', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.directory, 'imp-bench');

  expect(() => createDevLock(ctx.directory, 'imp-dev')).not.toThrow();
});

test('it refuses a lock that an exited process left, and names the file to remove', async () => {
  const ctx = await setupTest();

  const gone = Bun.spawn(['true']);

  await gone.exited;
  await writeFile(join(ctx.directory, 'impz-dev-imp-bench.lock'), String(gone.pid));

  expect(() => createDevLock(ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `process ${String(gone.pid)} has exited but left the lock on the dev instance imp-bench; remove ${join(ctx.directory, 'impz-dev-imp-bench.lock')} once no bench runs`,
  );
});

test('it leaves only the lock file behind, never its draft', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.directory, 'imp-bench');

  expect(() => createDevLock(ctx.directory, 'imp-bench')).toThrow();

  const files = await readdir(ctx.directory);

  expect(files).toStrictEqual(['impz-dev-imp-bench.lock']);
});
