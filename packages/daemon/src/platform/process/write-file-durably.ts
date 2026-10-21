import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DurableWriteOptions {
  readonly mode?: number;

  readonly sync?: (fd: number) => void;
}

const NEW_FILE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export function writeFileDurably(
  path: string,
  data: string | Uint8Array,
  options: DurableWriteOptions = {},
): void {
  const next = `${path}.new`;
  const sync = options.sync ?? fsyncSync;

  rmSync(next, { force: true });

  try {
    const file = openSync(next, NEW_FILE_FLAGS, options.mode ?? 0o644);

    try {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      let written = 0;

      while (written < bytes.length) {
        written += writeSync(file, bytes, written);
      }

      sync(file);
    } finally {
      closeSync(file);
    }

    renameSync(next, path);
  } finally {
    rmSync(next, { force: true });
  }

  // a rename survives a power loss only once its directory is flushed
  writeToDisk([dirname(path)], sync);
}

export async function writeFileDurablyAsync(
  path: string,
  data: string | Uint8Array,
  options: Omit<DurableWriteOptions, 'sync'> = {},
): Promise<void> {
  const next = `${path}.new`;

  await rm(next, { force: true });

  try {
    const file = await open(next, NEW_FILE_FLAGS, options.mode ?? 0o644);

    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(next, path);
  } finally {
    await rm(next, { force: true });
  }

  const directory = await open(dirname(path), 'r');

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function writeCopyDurably(from: string, to: string): void {
  const next = `${to}.new`;

  rmSync(next, { force: true });

  try {
    copyFileSync(from, next, constants.COPYFILE_EXCL);
    writeToDisk([next]);
    renameSync(next, to);
  } finally {
    rmSync(next, { force: true });
  }

  writeToDisk([dirname(to)]);
}

export function writeRenamed(from: string, to: string): void {
  renameSync(from, to);
  writeToDisk([dirname(to)]);
}

export function writeToDisk(
  paths: readonly string[],
  sync: (fd: number) => void = fsyncSync,
): void {
  for (const path of paths) {
    const fd = openSync(path, 'r');

    try {
      sync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
