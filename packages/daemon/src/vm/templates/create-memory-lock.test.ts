import { expect, mock, onTestFinished, test } from 'bun:test';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { createMemoryLock } from './create-memory-lock';

async function setupTest() {
  // tmpdir() is a tmpfs on some hosts, and this file's holes need a disk file system
  const directory = await mkdtemp(join('/var/tmp', 'memory-lock-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory };
}

test('it locks the data of a sparse file and none of its holes', async () => {
  const ctx = await setupTest();

  const path = join(ctx.directory, 'mem');
  const fd = openSync(path, 'w');

  writeSync(fd, Buffer.alloc(4096, 1), 0, 4096, 0);
  writeSync(fd, Buffer.alloc(8192, 2), 0, 8192, 1024 * 1024);
  closeSync(fd);

  await truncate(path, 4 * 1024 * 1024);

  const result = await createMemoryLock(path, () => true);

  invariant('lock' in result);
  onTestFinished(result.lock.release);

  const lockedKiB = readFileSync('/proc/self/smaps', 'utf8')
    .split(/\n(?=[\da-f]+-[\da-f]+ )/u)
    .filter((mapping) => mapping.split('\n')[0]?.endsWith(path) === true)
    .map((mapping) => Number(/^Locked:\s+(?<kib>\d+) kB$/mu.exec(mapping)?.groups?.['kib']));

  expect(result.lock.lockedBytes).toBe(12_288);

  // mlock splits the mapping at each locked run, so each data run and each hole is its own entry
  expect(lockedKiB).toStrictEqual([4, 0, 8, 0]);
});

test('it reports the bytes it will lock before it locks them', async () => {
  const ctx = await setupTest();

  const path = join(ctx.directory, 'mem');
  const fd = openSync(path, 'w');

  writeSync(fd, Buffer.alloc(4096, 1), 0, 4096, 0);
  writeSync(fd, Buffer.alloc(8192, 2), 0, 8192, 1024 * 1024);
  closeSync(fd);

  await truncate(path, 4 * 1024 * 1024);

  const smapsAtSize: string[] = [];

  const onSized = mock<(lockBytes: number) => boolean>(() => {
    smapsAtSize.push(readFileSync('/proc/self/smaps', 'utf8'));

    return true;
  });

  const result = await createMemoryLock(path, onSized);

  invariant('lock' in result);
  onTestFinished(result.lock.release);

  expect(onSized).toHaveBeenCalledExactlyOnceWith(12_288);
  expect(smapsAtSize).toSatisfyAll((smaps: string) => !smaps.includes(path));
});

test('it maps and locks nothing when the size report declines the lock', async () => {
  const ctx = await setupTest();

  const path = join(ctx.directory, 'mem');
  const fd = openSync(path, 'w');

  writeSync(fd, Buffer.alloc(8192, 1), 0, 8192, 0);
  closeSync(fd);

  const result = await createMemoryLock(path, () => false);

  expect(result).toStrictEqual({ declinedBytes: 8192 });
  expect(readFileSync('/proc/self/smaps', 'utf8')).not.toInclude(path);
});

test('it holds the locked pages in a mapping of the file until release', async () => {
  const ctx = await setupTest();

  const path = join(ctx.directory, 'mem');
  const fd = openSync(path, 'w');

  writeSync(fd, Buffer.alloc(8192, 1), 0, 8192, 0);
  closeSync(fd);

  const result = await createMemoryLock(path, () => true);

  invariant('lock' in result);

  const lockedKiB = readFileSync('/proc/self/smaps', 'utf8')
    .split(/\n(?=[\da-f]+-[\da-f]+ )/u)
    .filter((mapping) => mapping.split('\n')[0]?.endsWith(path) === true)
    .map((mapping) => Number(/^Locked:\s+(?<kib>\d+) kB$/mu.exec(mapping)?.groups?.['kib']));

  result.lock.release();
  result.lock.release();

  expect(lockedKiB).toStrictEqual([8]);
  expect(readFileSync('/proc/self/smaps', 'utf8')).not.toInclude(path);
});
