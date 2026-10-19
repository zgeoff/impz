import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// countTreeBytes' readDir over a real tree, where `dir` also lists `count`
// empty subdirectories, `sub-0` on, held as no state each: a directory too
// wide to make. Every other directory lists as readdir does.
export function buildStubWideDir(dir: string, count: number) {
  const prefix = join(dir, 'sub-');

  const isGenerated = (path: string): boolean => {
    const index = path.slice(prefix.length);

    return path.startsWith(prefix) && /^(?:0|[1-9]\d*)$/v.test(index) && Number(index) < count;
  };

  const readDir = async (path: string): Promise<Dirent[]> => {
    if (isGenerated(path)) {
      return [];
    }

    const entries = await readdir(path, { withFileTypes: true });

    if (path !== dir) {
      return entries;
    }

    for (let index = 0; index < count; index++) {
      entries.push(buildDirEntry(dir, `sub-${String(index)}`));
    }

    return entries;
  };

  return { readDir };
}

// every entry shares one copy of each test method
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

function isTrue(): boolean {
  return true;
}

function isFalse(): boolean {
  return false;
}
