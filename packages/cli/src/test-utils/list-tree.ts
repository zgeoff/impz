import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function listTree(directory: string): Promise<string[]> {
  const names = await readdir(directory, { recursive: true });

  const marked = await Promise.all(
    names.map(async (name) => {
      const stats = await lstat(join(directory, name));

      if (stats.isSymbolicLink()) {
        return `${name}@`;
      }

      if (stats.isDirectory()) {
        return `${name}/`;
      }

      return (stats.mode & 0o111) === 0 ? name : `${name}*`;
    }),
  );

  return marked.toSorted();
}
