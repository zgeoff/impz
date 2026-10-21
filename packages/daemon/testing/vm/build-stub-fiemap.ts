import { existsSync, rmSync } from 'node:fs';
import type { Extent, readExtents } from '../../src/vm/storage/fiemap';

export function buildStubFiemap() {
  const extents = new Map<string, readonly Extent[]>();
  const cuts = new Set<string>();
  const failures = new Map<string, Error>();
  const removals = new Set<string>();

  const reads: string[] = [];

  const readFileExtents: typeof readExtents = (path) => {
    reads.push(path);

    if (removals.has(path)) {
      rmSync(path, { force: true });
    }

    const failure = failures.get(path);

    if (failure !== undefined) {
      return Promise.reject(failure);
    }

    if (!existsSync(path)) {
      return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    }

    return Promise.resolve({
      extents: [...(extents.get(path) ?? [])],
      isComplete: !cuts.has(path),
    });
  };

  return {
    readFileExtents,
    reads,
    setExtents: (path: string, list: readonly Extent[]) => {
      extents.set(path, list);
    },

    setCut: (path: string, isCut: boolean) => {
      if (isCut) {
        cuts.add(path);
      } else {
        cuts.delete(path);
      }
    },
    failAt: (path: string, error: Error) => {
      failures.set(path, error);
    },

    removeBefore: (path: string) => {
      removals.add(path);
    },
  };
}
