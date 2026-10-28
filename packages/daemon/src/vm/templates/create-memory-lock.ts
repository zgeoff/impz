import { closeSync, fstatSync, openSync } from 'node:fs';
import { readErrno, readLibc } from '../../platform/process/libc';

const PROT_READ = 0x1;
const MAP_SHARED = 0x1;

export interface MemoryLock {
  readonly lockedBytes: number;
  readonly release: () => void;
}

export type MemoryLockResult = { readonly lock: MemoryLock } | { readonly errno: number };

export async function createMemoryLock(path: string): Promise<MemoryLockResult> {
  const libc = readLibc();

  if (libc === null) {
    return { errno: -1 };
  }

  const fd = openSync(path, 'r');

  try {
    const size = fstatSync(fd).size;
    const runs = readDataRuns(libc, fd, size);

    if ('errno' in runs) {
      return runs;
    }

    const address = Number(libc.mmap(0, size, PROT_READ, MAP_SHARED, fd, 0));

    if (address === -1) {
      return { errno: readErrno() };
    }

    const mapping = { isMapped: true };

    const release = (): void => {
      if (mapping.isMapped) {
        mapping.isMapped = false;

        libc.munmap(address, size);
      }
    };

    for (const chunk of runs.flatMap((run) => splitRun(run))) {
      if (libc.mlock(address + chunk.offset, chunk.length) !== 0) {
        const errno = readErrno();

        release();

        return { errno };
      }

      await Bun.sleep(0);
    }

    const lockedBytes = runs.reduce((total, run) => total + run.length, 0);

    return { lock: { lockedBytes, release } };
  } finally {
    closeSync(fd);
  }
}

// Linux's lseek(2) whence values, and the errno that ends the scan past the last data.
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;

type Libc = NonNullable<ReturnType<typeof readLibc>>;

interface Run {
  readonly offset: number;
  readonly length: number;
}

function readDataRuns(libc: Libc, fd: number, size: number): Run[] | { readonly errno: number } {
  const runs: Run[] = [];
  let offset = 0;

  while (offset < size) {
    const data = Number(libc.lseek(fd, offset, SEEK_DATA));

    if (data < 0) {
      const errno = readErrno();

      if (errno === ENXIO) {
        break;
      }

      return { errno };
    }

    const hole = Number(libc.lseek(fd, data, SEEK_HOLE));

    if (hole < 0) {
      return { errno: readErrno() };
    }

    const end = Math.min(hole, size);

    runs.push({ offset: data, length: end - data });

    offset = end;
  }

  return runs;
}

// mlock reads each page it locks from the filesystem, which on a cold cache is a disk read, so the
// lock yields to impd's event loop after each chunk.
const CHUNK_BYTES = 4 * 1024 * 1024;

function splitRun(run: Run): Run[] {
  return Array.from({ length: Math.ceil(run.length / CHUNK_BYTES) }, (_unused, index) => {
    const offset = run.offset + index * CHUNK_BYTES;

    return { offset, length: Math.min(CHUNK_BYTES, run.offset + run.length - offset) };
  });
}
