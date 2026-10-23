import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readDataBlocks } from './read-data-blocks';

const READ_BYTES = 1024 * 1024;

// The ZFS disk recordsize, and a multiple of XFS's 4 KiB block.
const WRITE_BYTES = 16 * 1024;

// On ZFS or XFS a block left alone stays shared with the snapshot or clone
// taken before, so only the blocks that differ are written.
export async function writeChangedBlocks(source: string, target: string): Promise<number> {
  const files: { input?: FileHandle; output?: FileHandle } = {};
  const wanted = Buffer.alloc(READ_BYTES);
  const present = Buffer.alloc(READ_BYTES);
  let written = 0;

  try {
    const input = await open(source, 'r');

    files.input = input;

    const output = await open(target, 'r+');

    files.output = output;

    const stats = await input.stat();

    const size = stats.size;

    const targetStats = await output.stat();

    const blocks = new Set([
      ...readDataBlocks({ fd: input.fd, size, blockBytes: READ_BYTES }),
      ...readDataBlocks({
        fd: output.fd,
        size: Math.min(targetStats.size, size),
        blockBytes: READ_BYTES,
      }),
    ]);

    // XFS preallocates past the end that each write extends, and leaves that space allocated
    await output.truncate(size);

    for (const block of [...blocks].toSorted((left, right) => left - right)) {
      const offset = block * READ_BYTES;
      const length = Math.min(READ_BYTES, size - offset);

      present.fill(0);

      await input.read(wanted, 0, length, offset);
      await output.read(present, 0, length, offset);

      if (wanted.compare(present, 0, length, 0, length) === 0) {
        continue;
      }

      for (let start = 0; start < length; start += WRITE_BYTES) {
        const end = Math.min(start + WRITE_BYTES, length);

        if (wanted.compare(present, start, end, start, end) !== 0) {
          await output.write(wanted, start, end - start, offset + start);

          written += end - start;
        }
      }
    }

    await output.sync();

    return written;
  } finally {
    await files.input?.close();
    await files.output?.close();
  }
}
