import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemDrivesDir } from './data-layout';

export function removeUnusedSystemDrives(dataDir: string, keep: ReadonlySet<string>): string[] {
  const directory = buildSystemDrivesDir(dataDir);
  const removed: string[] = [];

  for (const name of readNames(directory)) {
    // `keep` holds file names, not paths, so a data dir that moved never loses a drive in use
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
