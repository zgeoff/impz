import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemDrivesDir } from './data-layout';

// Deletes every system drive whose file name is not in `keep`, and any copy a
// crash cut short; returns the names it deleted. Names, not paths: a moved
// data dir must not delete a drive in use.
export function removeUnusedSystemDrives(dataDir: string, keep: ReadonlySet<string>): string[] {
  const directory = buildSystemDrivesDir(dataDir);
  const removed: string[] = [];

  for (const name of readNames(directory)) {
    if (!keep.has(name)) {
      rmSync(join(directory, name), { force: true });

      removed.push(name);
    }
  }

  return removed;
}

function readNames(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
