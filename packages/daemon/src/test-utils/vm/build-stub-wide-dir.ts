import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function buildStubWideDir(directory: string, count: number) {
  const prefix = join(directory, 'sub-');

  const isGenerated = (path: string): boolean => {
    const index = path.slice(prefix.length);

    return path.startsWith(prefix) && /^(?:0|[1-9]\d*)$/v.test(index) && Number(index) < count;
  };

  const readDir = async (path: string): Promise<Dirent[]> => {
    if (isGenerated(path)) {
      return [];
    }

    const entries = await readdir(path, { withFileTypes: true });

    if (path !== directory) {
      return entries;
    }

    for (let index = 0; index < count; index++) {
      entries.push(buildDirEntry(directory, `sub-${String(index)}`));
    }

    return entries;
  };

  return { readDir };
}

function buildDirEntry(parentPath: string, name: string): Dirent {
  return {
    name,
    parentPath,
    isFile: isFalse,
    isDirectory: isTrue,
    isBlockDevice: isFalse,
    isCharacterDevice: isFalse,
    isSymbolicLink: isFalse,
    isFIFO: isFalse,
    isSocket: isFalse,
  };
}

function isFalse(): boolean {
  return false;
}

function isTrue(): boolean {
  return true;
}
