import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ChangedPagesFS } from './count-changed-pages';

export function wireChangedPagesFS(): ChangedPagesFS {
  return {
    open: (path) => openSync(path, 'r'),
    readSize: (file) => fstatSync(file).size,
    read: (file, chunk, offset) => {
      readSync(file, chunk, 0, chunk.length, offset);
    },
    close: closeSync,
  };
}
