import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface CountTreeBytesDeps {
  readonly readDir?: (directory: string) => Promise<Dirent[]>;
}

export async function countTreeBytes(root: string, deps: CountTreeBytesDeps = {}): Promise<number> {
  const readDir = deps.readDir ?? readDirEntries;

  const inodes = new Map<string, number>();

  const dirs = [root];

  // a hand walk, because Bun's recursive readdir follows symlinks
  for (let directory = dirs.pop(); directory !== undefined; directory = dirs.pop()) {
    const entries = await readEntries(readDir, directory);

    // spreading a wide directory's subdirectories into push passes the engine's argument limit
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(join(directory, entry.name));
      }
    }

    const files = entries.filter((entry) => entry.isFile());

    const stats = await Promise.all(
      files.map((entry) => readFileStats(join(directory, entry.name))),
    );

    for (const stat of stats) {
      if (stat !== undefined) {
        // ZFS counts a 512-byte dnode slot in a file's blocks before its free space drops
        inodes.set(`${String(stat.dev)}:${String(stat.ino)}`, Math.max(0, stat.blocks - 1) * 512);
      }
    }
  }

  return [...inodes.values()].reduce((sum, bytes) => sum + bytes, 0);
}

function readDirEntries(directory: string): Promise<Dirent[]> {
  return readdir(directory, { withFileTypes: true });
}

async function readEntries(
  readDir: (directoryPath: string) => Promise<Dirent[]>,
  directory: string,
): Promise<Dirent[]> {
  try {
    return await readDir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readFileStats(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }

    throw error;
  }
}
