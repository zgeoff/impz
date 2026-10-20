import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrphanStorage } from './storage-backend';

// Anything in `dir` but empty directories: a socket or a log may be all an
// imp left, and only an empty directory is provably nothing
export function probeHoldingFiles(directory: string): boolean {
  return (
    existsSync(directory) &&
    readdirSync(directory, { recursive: true, withFileTypes: true }).some(
      (entry) => !entry.isDirectory(),
    )
  );
}

// every regular file under `dir`
export function listFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// An orphan kept as a directory. Its size counts the blocks a reflink
// shares in full.
export function readDirectoryOrphan(
  kind: OrphanStorage['kind'],
  id: string,
  directory: string,
  snapshots: readonly string[],
): OrphanStorage {
  const birth = statSync(directory).birthtimeMs;

  return {
    kind,
    id,
    location: directory,
    bytes: listFilesUnder(directory).reduce((sum, path) => sum + statSync(path).blocks * 512, 0),
    createdAt: birth > 0 ? new Date(birth) : null,
    snapshots,
  };
}
