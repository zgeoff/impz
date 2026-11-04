import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';

// The fsync lets a snapshot taken next hold the text; a `sync` would flush every
// filesystem on the runner.
export function writeSyncedFile(path: string, text: string): void {
  const fd = openSync(path, 'w');

  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
