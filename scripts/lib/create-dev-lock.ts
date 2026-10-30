import { join } from 'node:path';
import { formatHeldLock } from './format-held-lock.ts';
import { parseLockPid } from './parse-lock-pid.ts';

export interface DevLockIO {
  readonly pid: number;
  readonly writeText: (path: string, text: string) => void;
  readonly link: (target: string, path: string) => void;
  readonly readText: (path: string) => string | null;
  readonly remove: (path: string) => void;
  readonly probeProcessAlive: (pid: number) => boolean;
}

export interface DevLock {
  readonly release: () => void;
}

// The lock appears whole through a hard link to a file that already holds the
// PID, so no reader sees it empty. A dead holder's lock stays until someone
// removes it, since a takeover cannot be atomic.
export function createDevLock(io: DevLockIO, directory: string, name: string): DevLock {
  const path = join(directory, `impz-dev-${name}.lock`);
  const draft = `${path}.${String(io.pid)}`;

  io.writeText(draft, String(io.pid));

  try {
    io.link(draft, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(readHeldLock(io, path, name), { cause: error });
    }

    throw error;
  } finally {
    io.remove(draft);
  }

  // a second release would remove the lock of whoever took the name next
  let isReleased = false;

  return {
    release: () => {
      if (isReleased) {
        return;
      }

      isReleased = true;

      io.remove(path);
    },
  };
}

function readHeldLock(io: DevLockIO, path: string, name: string): string {
  const pid = parseLockPid(io.readText(path));

  return formatHeldLock({
    path,
    name,
    holder: pid === null ? null : { pid, isAlive: io.probeProcessAlive(pid) },
  });
}
