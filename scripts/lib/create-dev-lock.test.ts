import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevLock } from './create-dev-lock';
import { wireDevLockIO } from './wire-dev-lock-io';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'dev-lock-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory, io: wireDevLockIO() };
}

test('it refuses a second lock on a dev instance while the first holds it', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.io, ctx.directory, 'imp-bench');

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `process ${String(process.pid)} holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it locks a dev instance again once the last lock was released', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.io, ctx.directory, 'imp-bench').release();

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).not.toThrow();
});

test('it locks two dev instances of different names at once', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.io, ctx.directory, 'imp-bench');
  createDevLock(ctx.io, ctx.directory, 'imp-dev');

  const files = await readdir(ctx.directory);

  expect(files).toIncludeSameMembers(['impz-dev-imp-bench.lock', 'impz-dev-imp-dev.lock']);
});

test('it keeps the lock it took when its draft cannot be removed', async () => {
  const ctx = await setupTest();

  createDevLock(
    {
      ...ctx.io,
      remove: () => {
        throw new Error('EBUSY: resource busy or locked, rm');
      },
    },
    ctx.directory,
    'imp-bench',
  );

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `process ${String(process.pid)} holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it names the holder of a lock it could not take, though its draft cannot be removed', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'impz-dev-imp-bench.lock'), '4242');

  expect(() =>
    createDevLock(
      {
        ...ctx.io,
        remove: () => {
          throw new Error('EBUSY: resource busy or locked, rm');
        },
        probeProcessAlive: () => true,
      },
      ctx.directory,
      'imp-bench',
    ),
  ).toThrowWithMessage(
    Error,
    `process 4242 holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it refuses a lock that a live process holds', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'impz-dev-imp-bench.lock'), '4242');

  expect(() =>
    createDevLock({ ...ctx.io, probeProcessAlive: () => true }, ctx.directory, 'imp-bench'),
  ).toThrowWithMessage(
    Error,
    `process 4242 holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it refuses a lock that an exited process left, and names the file to remove', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'impz-dev-imp-bench.lock'), '4242');

  expect(() =>
    createDevLock({ ...ctx.io, probeProcessAlive: () => false }, ctx.directory, 'imp-bench'),
  ).toThrowWithMessage(
    Error,
    `process 4242 has exited but left the lock on the dev instance imp-bench; remove ${join(ctx.directory, 'impz-dev-imp-bench.lock')} once no bench runs`,
  );
});

test('it refuses a lock that names no process, and names the file to remove', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'impz-dev-imp-bench.lock'), 'imp-bench');

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `the lock on the dev instance imp-bench names no process; remove ${join(ctx.directory, 'impz-dev-imp-bench.lock')} once no bench runs`,
  );
});

test('it keeps the next holder lock when an earlier holder releases twice', async () => {
  const ctx = await setupTest();

  const first = createDevLock(ctx.io, ctx.directory, 'imp-bench');

  first.release();

  createDevLock(ctx.io, ctx.directory, 'imp-bench');

  first.release();

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).toThrowWithMessage(
    Error,
    `process ${String(process.pid)} holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it leaves only the lock file behind, never its draft', async () => {
  const ctx = await setupTest();

  createDevLock(ctx.io, ctx.directory, 'imp-bench');

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).toThrow();

  const files = await readdir(ctx.directory);

  expect(files).toStrictEqual(['impz-dev-imp-bench.lock']);
});

test('it fails with the link error and leaves no draft when the link fails another way', async () => {
  const ctx = await setupTest();

  const linkFailure = Object.assign(new Error('EACCES: permission denied, link'), {
    code: 'EACCES',
  });

  expect(() =>
    createDevLock(
      {
        ...ctx.io,
        link: () => {
          throw linkFailure;
        },
      },
      ctx.directory,
      'imp-bench',
    ),
  ).toThrow(linkFailure);

  const files = await readdir(ctx.directory);

  expect(files).toStrictEqual([]);
});

test('it takes no lock when its draft cannot be written', async () => {
  const ctx = await setupTest();

  expect(() =>
    createDevLock(
      {
        ...ctx.io,
        writeText: () => {
          throw new Error('ENOSPC: no space left on device, write');
        },
      },
      ctx.directory,
      'imp-bench',
    ),
  ).toThrowWithMessage(Error, 'ENOSPC: no space left on device, write');

  expect(() => createDevLock(ctx.io, ctx.directory, 'imp-bench')).not.toThrow();
});
