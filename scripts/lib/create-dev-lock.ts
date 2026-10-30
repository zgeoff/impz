import { linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './read-text.ts';
import { removeFile } from './remove-file.ts';

export interface DevLock {
  readonly release: () => void;
}

// The lock appears whole through a hard link to a file that already holds the
// PID, so no reader sees it empty. A dead holder's lock stays until someone
// removes it, since a takeover cannot be atomic.
export function createDevLock(directory: string, name: string): DevLock {
  const path = join(directory, `impz-dev-${name}.lock`);
  const draft = `${path}.${String(process.pid)}`;

  writeFileSync(draft, String(process.pid));

  try {
    linkSync(draft, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(readHeldLock(path, name), { cause: error });
    }

    throw error;
  } finally {
    removeFile(draft);
  }

  return {
    release: () => {
      removeFile(path);
    },
  };
}

function readHeldLock(path: string, name: string): string {
  const holder = Number(readText(path));

  if (probeProcessAlive(holder)) {
    return `process ${String(holder)} holds the dev instance ${name} (${path})`;
  }

  return `process ${String(holder)} has exited but left the lock on the dev instance ${name}; remove ${path} once no bench runs`;
}

function probeProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
