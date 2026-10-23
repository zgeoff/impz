import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';

// As realpath -m: each part resolves in turn, so a .. after a symlink leaves the symlink's target.
// Bun's realpathSync, native or not, folds every .. before it reads a link.
export function readRealPath(path: string, cwd: string): string {
  const parts = (isAbsolute(path) ? path : `${cwd}${sep}${path}`).split(sep);
  let real: string = sep;

  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }

    real = part === '..' ? dirname(real) : resolveExisting(join(real, part));
  }

  return real;
}

// A part that does not exist is kept as it is written.
function resolveExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
