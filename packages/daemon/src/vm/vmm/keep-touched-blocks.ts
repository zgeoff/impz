import { copyFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { getErrorMessage } from '@impz/shared';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { ImpPaths } from '../storage/build-imp-paths';

// An imp with no handler run, such as a cold-booted one, leaves no record, and
// the next warm then reads the whole file. So does an older handler build that
// ignores descriptor 5: it leaves the file empty, and the flags it refuses.
type TouchedPaths = Pick<ImpPaths, 'impId' | 'memTouched' | 'uffdTouchedFile'>;

// Keeps the blocks that the sleeping imp's page handler served beside the new
// memory file, where they outlive the run directory and an impd restart.
export function keepTouchedBlocks(paths: Readonly<TouchedPaths>): void {
  dropTouchedBlocks(paths);

  if (!probeMarks(paths.uffdTouchedFile)) {
    return;
  }

  const staged = `${paths.memTouched}.new`;

  try {
    copyFileSync(paths.uffdTouchedFile, staged);
    renameSync(staged, paths.memTouched);
  } catch (error) {
    rmSync(staged, { force: true });

    getImpdLogger('imps')
      .with({ imp: paths.impId })
      .warning('kept no record of the blocks the wake served: {error}', {
        error: getErrorMessage(error),
      });
  }
}

// The record describes the memory file beside it, so a sleep that replaces the
// file drops it first.
export function dropTouchedBlocks(paths: Readonly<Pick<ImpPaths, 'memTouched'>>): void {
  rmSync(paths.memTouched, { force: true });
}

function probeMarks(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}
