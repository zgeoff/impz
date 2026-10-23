import { fstatSync } from 'node:fs';
import { readErrno, readLibc } from '../../platform/process/libc';
import { EXTENT_FLAGS, readOpenFileExtents, readSyncedExtentBatch } from '../../vm/storage/fiemap';

// Linux's lseek(2) whence values, and the one errno that is an answer.
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;

type SeekResult = { readonly offset: number } | { readonly errno: number };

type SeekFile = (fd: number, offset: number, whence: number) => SeekResult;

type ReadAllocated = (fd: number) => number;

export interface ReadDataBlocksOptions {
  readonly fd: number;
  readonly size: number;
  readonly blockBytes: number;
  readonly seek?: SeekFile;
  readonly readAllocated?: ReadAllocated;
}

export function readDataBlocks(options: ReadDataBlocksOptions): Set<number> {
  const fd = options.fd;
  const size = options.size;
  const blockBytes = options.blockBytes;
  const seek = options.seek ?? runLseek;
  const readAllocated = options.readAllocated ?? readFileAllocated;

  const blocks = new Set<number>();

  let foundBytes = 0;
  let offset = 0;

  while (offset < size) {
    const data = seek(fd, offset, SEEK_DATA);

    if ('errno' in data && data.errno !== ENXIO) {
      return buildBlocksFrom(blocks, offset, size, blockBytes);
    }

    if ('errno' in data || data.offset >= size) {
      break;
    }

    const hole = seek(fd, data.offset, SEEK_HOLE);

    if ('errno' in hole) {
      return buildBlocksFrom(blocks, data.offset, size, blockBytes);
    }

    const end = Math.min(hole.offset, size);

    for (let block = Math.floor(data.offset / blockBytes); block * blockBytes < end; block += 1) {
      blocks.add(block);
    }

    foundBytes += end - data.offset;
    offset = end;
  }

  if (offset < size && isScanShort(foundBytes, readAllocated(fd))) {
    return buildBlocksFrom(blocks, offset, size, blockBytes);
  }

  return blocks;
}

function runLseek(fd: number, offset: number, whence: number): SeekResult {
  const libc = readLibc();

  if (libc === null) {
    return { errno: -1 };
  }

  const result = Number(libc.lseek(fd, offset, whence));

  if (result >= 0) {
    return { offset: result };
  }

  return { errno: readErrno() };
}

// st_blocks counts unwritten extents, which SEEK_DATA skips as holes, so they are no data the scan
// missed; XFS leaves them where it preallocates ahead of a file's growing end.
function readFileAllocated(fd: number): number {
  const unwrittenBytes = (readOpenFileExtents(fd, readSyncedExtentBatch) ?? [])
    .filter((extent) => (extent.flags & EXTENT_FLAGS.unwritten) !== 0)
    .reduce((total, extent) => total + extent.length, 0);

  return fstatSync(fd).blocks * 512 - unwrittenBytes;
}

function buildBlocksFrom(
  found: ReadonlySet<number>,
  offset: number,
  size: number,
  blockBytes: number,
): Set<number> {
  const blocks = new Set(found);

  for (let block = Math.floor(offset / blockBytes); block * blockBytes < size; block += 1) {
    blocks.add(block);
  }

  return blocks;
}

// Allocated bytes past the found data can be file-system metadata rather than
// data the scan missed; a file restic restored measured 0 on XFS and ext4.
const SLACK_MIN_BYTES = 1024 * 1024;
const SLACK_FRACTION = 0.001;

// The errno lseek leaves may be stale, so the check compares allocated bytes
// with the data found instead.
function isScanShort(foundBytes: number, allocated: number): boolean {
  return allocated - foundBytes > Math.max(SLACK_MIN_BYTES, allocated * SLACK_FRACTION);
}
