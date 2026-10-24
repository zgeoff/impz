import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubLseek } from '../../../testing/vm/build-stub-lseek';
import { readDataBlocks } from './read-data-blocks';

// This needs the small real filesystem that IMP_TEST_SMALL_FS names, which CI mounts as a loop
// XFS, and skips without it.
test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it skips a fallocated range past the data of a file on a small filesystem',
  () => {
    const directory = mkdtempSync(join(process.env['IMP_TEST_SMALL_FS'] ?? '', 'seek-'));

    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    const path = join(directory, 'preallocated');
    const fd = openSync(path, 'w+');

    onTestFinished(() => {
      closeSync(fd);
    });

    writeSync(fd, Buffer.alloc(2 * 1024 ** 2, 3), 0, 2 * 1024 ** 2, 0);
    fsyncSync(fd);

    const fallocate = Bun.spawnSync([
      'fallocate',
      '--offset',
      String(8 * 1024 ** 2),
      '--length',
      String(16 * 1024 ** 2),
      path,
    ]);

    invariant(fallocate.exitCode === 0, fallocate.stderr.toString());

    expect([
      ...readDataBlocks({ fd, size: 24 * 1024 ** 2, blockBytes: 1024 ** 2 }),
    ]).toIncludeSameMembers([0, 1]);
  },
);

// This needs the small real filesystem that IMP_TEST_SMALL_FS names, which CI mounts as a loop
// XFS, and skips without it.
test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it reads every block from a hole start when a stale ENXIO hid unsynced data in a fallocated range on a small filesystem',
  () => {
    const directory = mkdtempSync(join(process.env['IMP_TEST_SMALL_FS'] ?? '', 'seek-'));

    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    const path = join(directory, 'preallocated');
    const fd = openSync(path, 'w+');

    onTestFinished(() => {
      closeSync(fd);
    });

    writeSync(fd, Buffer.alloc(2 * 1024 ** 2, 3), 0, 2 * 1024 ** 2, 0);
    fsyncSync(fd);

    const fallocate = Bun.spawnSync([
      'fallocate',
      '--offset',
      String(8 * 1024 ** 2),
      '--length',
      String(16 * 1024 ** 2),
      path,
    ]);

    invariant(fallocate.exitCode === 0, fallocate.stderr.toString());
    writeSync(fd, Buffer.alloc(2 * 1024 ** 2, 4), 0, 2 * 1024 ** 2, 8 * 1024 ** 2);

    const lseek = buildStubLseek({
      size: 24 * 1024 ** 2,
      extents: [
        [0, 2 * 1024 ** 2],
        [8 * 1024 ** 2, 10 * 1024 ** 2],
      ],
      staleEnxioFrom: 2 * 1024 ** 2,
    });

    const blocks = readDataBlocks({
      fd,
      size: 24 * 1024 ** 2,
      blockBytes: 1024 ** 2,
      seek: lseek.seek,
    });

    expect(blocks.size).toBe(24);
  },
);
