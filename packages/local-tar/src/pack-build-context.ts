import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore from '@balena/dockerignore';
import type { LocalEntry } from './pack-local-path';
import { listDockerfileCandidates } from './write-build-context';

export class MissingDockerfileError extends Error {
  override readonly name = 'MissingDockerfileError';
}

export function listContextEntries(
  root: string,
  dockerfile: string,
): Promise<readonly LocalEntry[]> {
  const found = listDockerfileCandidates(posix.normalize(dockerfile)).find((candidate) =>
    existsSync(join(root, candidate)),
  );

  if (found === undefined) {
    return Promise.reject(new MissingDockerfileError(`there is no ${dockerfile} in ${root}`));
  }

  return listEntries(root, found);
}

const ENTRY_KINDS = [
  ['directory', 'isDirectory'],
  ['symlink', 'isSymbolicLink'],
  ['file', 'isFile'],
] as const;

async function listEntries(root: string, dockerfile: string): Promise<readonly LocalEntry[]> {
  const ignoreName = existsSync(join(root, `${dockerfile}.dockerignore`))
    ? `${dockerfile}.dockerignore`
    : '.dockerignore';

  const patterns = existsSync(join(root, ignoreName))
    ? await readFile(join(root, ignoreName), 'utf8')
    : '';

  const matcher = ignore().add(patterns);

  // With no `!` exception, nothing under an ignored directory comes back.
  const hasExceptions = patterns.split('\n').some((line) => line.trim().startsWith('!'));
  const dockerfileName = posix.normalize(dockerfile);

  const isDockerfileBelow = (directory: string): boolean =>
    dockerfileName.startsWith(`${directory}/`);

  const readEntries = async (directory: string, prefix: string): Promise<LocalEntry[]> => {
    const entries: LocalEntry[] = [];

    const children = await readdir(directory);

    for (const child of children.toSorted()) {
      const path = join(directory, child);
      const name = prefix === '' ? child : `${prefix}/${child}`;

      const stats = await lstat(path);

      // docker reads the Dockerfile from the tar, so an ignore file never leaves it out.
      const ignored = matcher.ignores(name) && name !== dockerfileName;

      const entry: LocalEntry = {
        path,
        name,
        kind: ENTRY_KINDS.find(([, check]) => stats[check]())?.[0] ?? 'other',
        size: stats.size,
        mode: stats.mode & 0o7777,
        mtimeMs: stats.mtimeMs,
      };

      if (entry.kind !== 'directory') {
        if (!ignored) {
          entries.push(entry);
        }

        continue;
      }

      if (!ignored) {
        entries.push(entry, ...(await readEntries(path, name)));
        continue;
      }

      // docker sends an ignored directory only as the parent of an entry that
      // comes back.
      if (hasExceptions || isDockerfileBelow(name)) {
        const below = await readEntries(path, name);

        if (below.length > 0) {
          entries.push(entry, ...below);
        }
      }
    }

    return entries;
  };

  return readEntries(root, '');
}
