import { fstatSync } from 'node:fs';
import { readErrno, readLibc } from '../../platform/process/libc';

// Linux's lseek(2) whence values, and the one errno that is an answer.
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;

type SeekResult = { readonly offset: number } | { readonly errno: number };

export type SeekFile = (fd: number, offset: number, whence: number) => SeekResult;

export type ReadAllocated = (fd: number) => number;

export function readDataBlocks(
  fd: number,
  size: number,
  blockBytes: number,
  seek: SeekFile = runLseek,
  readAllocated: ReadAllocated = readFileAllocated,
): Set<number> {
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

function readFileAllocated(fd: number): number {
  return fstatSync(fd).blocks * 512;
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
