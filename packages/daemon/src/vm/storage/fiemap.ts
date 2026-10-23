import { ptr } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';
import { readErrno, readLibc } from '../../platform/process/libc';

// _IOWR('f', 11, struct fiemap): the kernel's 32-byte header, with the extents after it
const FS_IOC_FIEMAP = 0xc0_20_66_0b;
const HEADER_BYTES = 32;
const EXTENT_BYTES = 56;

// each FIEMAP call holds the file's inode lock, which a running guest's writes wait on
const BATCH_EXTENTS = 1024;

export const EXTENT_FLAGS = {
  last: 0x1,

  // the kernel gives a delayed allocation no block yet, so no physical address either
  delalloc: 0x4,

  // space fallocate or XFS's preallocation reserved, which reads as zeros and holds no data
  unwritten: 0x8_00,
  shared: 0x20_00,
} as const;

export interface Extent {
  readonly logical: number;
  readonly physical: number;
  readonly length: number;
  readonly flags: number;
}

interface ExtentRead {
  readonly extents: Extent[];
  readonly isComplete: boolean;
}

export type ExtentBatchRead = { readonly extents: Extent[] } | { readonly errno: number };

function readBatch(fd: number, start: number, buffer: Uint8Array, flags: number): ExtentBatchRead {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  buffer.fill(0);
  view.setBigUint64(0, BigInt(start), true);
  view.setBigUint64(8, 0xff_ff_ff_ff_ff_ff_ff_ffn, true);
  view.setUint32(16, flags, true);
  view.setUint32(24, BATCH_EXTENTS, true);

  const result = readLibc()?.ioctl(fd, FS_IOC_FIEMAP, ptr(buffer));

  if (result !== 0) {
    return { errno: readErrno() };
  }

  const mapped = view.getUint32(20, true);

  const extents = Array.from({ length: mapped }, (_unused, index) => {
    const at = HEADER_BYTES + index * EXTENT_BYTES;

    return {
      logical: Number(view.getBigUint64(at, true)),
      physical: Number(view.getBigUint64(at + 8, true)),
      length: Number(view.getBigUint64(at + 16, true)),
      flags: view.getUint32(at + 40, true),
    };
  });

  return { extents };
}

export async function readExtents(path: string, deadline: number): Promise<ExtentRead> {
  const fd = openSync(path, 'r');

  const buffer = new Uint8Array(HEADER_BYTES + BATCH_EXTENTS * EXTENT_BYTES);

  const extents: Extent[] = [];

  try {
    for (let start = 0; ;) {
      if (Date.now() > deadline) {
        return { extents, isComplete: false };
      }

      // FIEMAP_FLAG_SYNC stays off, because it flushes the guest's dirty pages first
      const read = readBatch(fd, start, buffer, 0);

      if ('errno' in read) {
        throw new Error(`FIEMAP failed: errno ${String(read.errno)}`);
      }

      const batch = read.extents;
      const last = batch.at(-1);

      extents.push(...batch);

      if (last === undefined || (last.flags & EXTENT_FLAGS.last) !== 0) {
        return { extents, isComplete: true };
      }

      start = last.logical + last.length;

      await Bun.sleep(0);
    }
  } finally {
    closeSync(fd);
  }
}

export type ReadExtentBatch = (fd: number, start: number) => ExtentBatchRead;

// null where the file system has no FIEMAP, as on ZFS or tmpfs
export function readOpenFileExtents(fd: number, readExtentBatch: ReadExtentBatch): Extent[] | null {
  const extents: Extent[] = [];

  for (let start = 0; ;) {
    const read = readExtentBatch(fd, start);

    if ('errno' in read) {
      return null;
    }

    const last = read.extents.at(-1);

    extents.push(...read.extents);

    if (last === undefined || (last.flags & EXTENT_FLAGS.last) !== 0) {
      return extents;
    }

    start = last.logical + last.length;
  }
}

const FIEMAP_FLAG_SYNC = 0x1;

// flushes first, because the kernel keeps an extent unwritten until writeback even when the page
// cache holds data for it
export function readSyncedExtentBatch(fd: number, start: number): ExtentBatchRead {
  return readBatch(
    fd,
    start,
    new Uint8Array(HEADER_BYTES + BATCH_EXTENTS * EXTENT_BYTES),
    FIEMAP_FLAG_SYNC,
  );
}
