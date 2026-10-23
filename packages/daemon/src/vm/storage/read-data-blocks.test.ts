import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubLseek } from '../../../testing/vm/build-stub-lseek';
import { readDataBlocks } from './read-data-blocks';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'impd-seek-test-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const fd = openSync(join(directory, 'sparse'), 'w+');

  onTestFinished(() => {
    closeSync(fd);
  });

  return { fd };
}

test('it finds the blocks of a sparse file that hold data, and skips the holes', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'head', 0);
  writeSync(ctx.fd, 'middle', 5 * 1024 ** 2 + 10);
  writeSync(ctx.fd, 'tail', 64 * 1024 ** 2 - 4);

  expect([
    ...readDataBlocks({ fd: ctx.fd, size: 64 * 1024 ** 2, blockBytes: 1024 ** 2 }),
  ]).toIncludeSameMembers([0, 5, 63]);
});

test('it finds no blocks in a scan of no length', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'head', 0);

  expect(readDataBlocks({ fd: ctx.fd, size: 0, blockBytes: 1024 ** 2 })).toBeEmpty();
});

test('it finds data past 4 GiB, where a 32-bit offset would wrap', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'five', 5 * 1024 ** 3 + 3);
  writeSync(ctx.fd, 'nine', 9 * 1024 ** 3);
  writeSync(ctx.fd, 'end', 32 * 1024 ** 3 - 3);

  expect([
    ...readDataBlocks({ fd: ctx.fd, size: 32 * 1024 ** 3, blockBytes: 1024 ** 2 }),
  ]).toIncludeSameMembers([5 * 1024, 9 * 1024, 32 * 1024 - 1]);
});

test('it reads every block from the data found when SEEK_HOLE fails', () => {
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [[0, 1024 ** 2]],
    holeErrno: 22,
  });

  const blocks = readDataBlocks({
    fd: 3,
    size: 4 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
    readAllocated: lseek.readAllocated,
  });

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it reads every block when SEEK_DATA fails with an error other than ENXIO', () => {
  const lseek = buildStubLseek({ size: 2 * 1024 ** 2, extents: [[0, 1024 ** 2]], dataErrno: 5 });

  const blocks = readDataBlocks({
    fd: 3,
    size: 2 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
    readAllocated: lseek.readAllocated,
  });

  expect([...blocks]).toIncludeSameMembers([0, 1]);
});

test('it finds no blocks in a file that is one hole', () => {
  const lseek = buildStubLseek({ size: 2 * 1024 ** 2, extents: [] });

  const blocks = readDataBlocks({
    fd: 3,
    size: 2 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
    readAllocated: lseek.readAllocated,
  });

  expect(blocks).toBeEmpty();
});

test('it reads every block from a hole start when fstat counts more than a stale ENXIO found', () => {
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [
      [0, 1024 ** 2],
      [2 * 1024 ** 2, 4 * 1024 ** 2],
    ],
    staleEnxioFrom: 1024 ** 2,
  });

  const blocks = readDataBlocks({
    fd: 3,
    size: 4 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
    readAllocated: lseek.readAllocated,
  });

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it keeps the scan when fstat counts no more than metadata past what it found', () => {
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [[0, 1024 ** 2]],
    metadataBytes: 4096,
  });

  const blocks = readDataBlocks({
    fd: 3,
    size: 4 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
    readAllocated: lseek.readAllocated,
  });

  expect([...blocks]).toIncludeSameMembers([0]);
});

test('it finds the extents of a real sparse file', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, Buffer.alloc(3 * 1024 ** 2, 1), 0, 3 * 1024 ** 2, 0);
  writeSync(ctx.fd, Buffer.alloc(2 * 1024 ** 2, 2), 0, 2 * 1024 ** 2, 40 * 1024 ** 2);

  expect([
    ...readDataBlocks({ fd: ctx.fd, size: 42 * 1024 ** 2, blockBytes: 1024 ** 2 }),
  ]).toIncludeSameMembers([0, 1, 2, 40, 41]);
});

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

test('it reads every block of a real sparse file when fstat shows an extent a stale ENXIO hid', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, Buffer.alloc(3 * 1024 ** 2, 1), 0, 3 * 1024 ** 2, 0);
  writeSync(ctx.fd, Buffer.alloc(2 * 1024 ** 2, 2), 0, 2 * 1024 ** 2, 40 * 1024 ** 2);

  const lseek = buildStubLseek({
    size: 42 * 1024 ** 2,
    extents: [
      [0, 3 * 1024 ** 2],
      [40 * 1024 ** 2, 42 * 1024 ** 2],
    ],
    staleEnxioFrom: 3 * 1024 ** 2,
  });

  const blocks = readDataBlocks({
    fd: ctx.fd,
    size: 42 * 1024 ** 2,
    blockBytes: 1024 ** 2,
    seek: lseek.seek,
  });

  expect(blocks.size).toBe(42);
});
