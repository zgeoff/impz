import type { ReadAllocated, SeekFile } from '../../src/imp-ops/backup/read-data-blocks';

const SEEK_DATA = 3;
const SEEK_HOLE = 4;

interface StubLseekOptions {
  readonly size: number;
  readonly extents: readonly (readonly [number, number])[];

  readonly staleEnxioFrom?: number;

  readonly dataErrno?: number;
  readonly holeErrno?: number;

  readonly metadataBytes?: number;
}

export function buildStubLseek(options: Readonly<StubLseekOptions>) {
  const runSeek: SeekFile = (_fd, offset, whence) => {
    if (whence === SEEK_DATA) {
      return findData(options, offset);
    }

    if (whence === SEEK_HOLE) {
      return findHole(options, offset);
    }

    return { errno: 22 };
  };

  const allocated = options.extents.reduce((total, [start, end]) => total + end - start, 0);
  const readAllocated: ReadAllocated = () => allocated + (options.metadataBytes ?? 0);

  return { seek: runSeek, readAllocated };
}

const ENXIO = 6;

function findData(options: Readonly<StubLseekOptions>, offset: number) {
  if (options.dataErrno !== undefined) {
    return { errno: options.dataErrno };
  }

  if (offset >= options.size || offset >= (options.staleEnxioFrom ?? Infinity)) {
    return { errno: ENXIO };
  }

  const extent = options.extents.find(([, end]) => end > offset);

  return extent === undefined ? { errno: ENXIO } : { offset: Math.max(extent[0], offset) };
}

// Linux's SEEK_HOLE counts EOF as a hole.
function findHole(options: Readonly<StubLseekOptions>, offset: number) {
  if (options.holeErrno !== undefined) {
    return { errno: options.holeErrno };
  }

  if (offset >= options.size) {
    return { errno: ENXIO };
  }

  const extent = options.extents.find(([start, end]) => start <= offset && offset < end);

  return { offset: extent === undefined ? offset : Math.min(extent[1], options.size) };
}
