import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { readDataBlocks } from './read-data-blocks';
import { writeChangedBlocks } from './write-changed-blocks';

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
