import { expect, mock, onTestFinished, test } from 'bun:test';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
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
  onTestFinished(result.lock.release);

  const lockedKiB = readFileSync('/proc/self/smaps', 'utf8')
    .split(/\n(?=[\da-f]+-[\da-f]+ )/u)
    .filter((mapping) => mapping.split('\n')[0]?.endsWith(path) === true)
    .map((mapping) => Number(/^Locked:\s+(?<kib>\d+) kB$/mu.exec(mapping)?.groups?.['kib']));

  result.lock.release();
  result.lock.release();

  expect(lockedKiB).toStrictEqual([8]);
  expect(readFileSync('/proc/self/smaps', 'utf8')).not.toInclude(path);
});

test('it unmaps the file when the lock passes the locked-memory limit', async () => {
  const ctx = await setupTest();

  const path = join(ctx.directory, 'mem');
  const fd = openSync(path, 'w');

  writeSync(fd, Buffer.alloc(1024 * 1024, 1), 0, 1024 * 1024, 0);
  closeSync(fd);

  const modulePath = join(import.meta.dir, 'create-memory-lock.ts');

  const script = `
    import { readFileSync } from 'node:fs';
    import { createMemoryLock } from ${JSON.stringify(modulePath)};
    const result = await createMemoryLock(${JSON.stringify(path)}, () => true);
    const smaps = readFileSync('/proc/self/smaps', 'utf8');
    console.log(JSON.stringify({ result, isMapped: smaps.includes(${JSON.stringify(path)}) }));
  `;

  // CAP_IPC_LOCK lifts the limit for a root test run, and a process in a new user namespace lacks
  // it on the host, so the child's mlock fails on the limit as it does for an unprivileged impd
  const report: unknown =
    await $`prlimit --memlock=65536:65536 unshare --user --map-root-user ${process.execPath} --eval ${script}`
      .quiet()
      .json();

  // ENOMEM: mlock(2) refuses a lock past a nonzero RLIMIT_MEMLOCK with it
  expect(report).toStrictEqual({ result: { errno: 12 }, isMapped: false });
});
