import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDataBlocks } from './read-data-blocks';
import { writeChangedBlocks } from './write-changed-blocks';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'impd-blocks-test-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { source: join(directory, 'source'), target: join(directory, 'target') };
}

test('it writes only the 16 KiB blocks that differ', async () => {
  const ctx = setupTest();
  const before = Buffer.alloc(3 * 1024 ** 2, 7);
  const after = Buffer.from(before);

  after.fill(9, 1024 ** 2 + 100, 1024 ** 2 + 200);

  writeFileSync(ctx.source, after);
  writeFileSync(ctx.target, before);

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(16 * 1024);
  expect(readFileSync(ctx.target)).toStrictEqual(after);
});

test('it fills an empty file and leaves its zero blocks as holes', async () => {
  const ctx = setupTest();
  const sparse = Buffer.alloc(8 * 1024 ** 2);

  sparse.write('head', 0);
  sparse.write('tail', 8 * 1024 ** 2 - 4);

  writeFileSync(ctx.source, sparse);
  writeFileSync(ctx.target, '');

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(2 * 16 * 1024);
  expect(readFileSync(ctx.target)).toStrictEqual(sparse);
  expect(statSync(ctx.target).blocks * 512).toBeLessThan(1024 ** 2);
});

test('it shrinks a target longer than the source', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.source, 'short');
  writeFileSync(ctx.target, Buffer.alloc(1024 ** 2, 1));

  await writeChangedBlocks(ctx.source, ctx.target);

  expect(readFileSync(ctx.target, 'utf8')).toBe('short');
});

// This needs the small real filesystem that IMP_TEST_SMALL_FS names, which CI mounts as a loop
// XFS, and skips without it.
test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it gives a filled file the data blocks and the allocation of its source on a small filesystem',
  async () => {
    const directory = mkdtempSync(join(process.env['IMP_TEST_SMALL_FS'] ?? '', 'blocks-'));

    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    const source = join(directory, 'source');
    const target = join(directory, 'target');
    const sourceFD = openSync(source, 'w+');

    onTestFinished(() => {
      closeSync(sourceFD);
    });

    ftruncateSync(sourceFD, 1024 ** 3);

    for (let offset = 0; offset < 64 * 1024 ** 2; offset += 512 * 1024) {
      writeSync(sourceFD, randomBytes(16 * 1024), 0, 16 * 1024, offset);
    }

    fsyncSync(sourceFD);
    writeFileSync(target, '');

    await writeChangedBlocks(source, target);

    const targetFD = openSync(target, 'r');

    onTestFinished(() => {
      closeSync(targetFD);
    });

    expect(readDataBlocks({ fd: targetFD, size: 1024 ** 3, blockBytes: 1024 ** 2 }).size).toBe(
      readDataBlocks({ fd: sourceFD, size: 1024 ** 3, blockBytes: 1024 ** 2 }).size,
    );

    expect(fstatSync(targetFD).blocks).toBe(fstatSync(sourceFD).blocks);
  },
);

test('it closes the source when the target will not open', () => {
  const ctx = setupTest();

  writeFileSync(ctx.source, 'data');

  expect(writeChangedBlocks(ctx.source, ctx.target)).rejects.toThrow('ENOENT');

  const open = Bun.spawnSync(['find', `/proc/${String(process.pid)}/fd`, '-lname', ctx.source]);

  expect(open.stdout.toString()).toBe('');
});
