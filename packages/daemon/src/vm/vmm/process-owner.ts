import { closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPidfdLibc } from '../../platform/process/libc';
import { stopPid } from '../../platform/process/proc';

interface ProcessUids {
  readonly real: number;
  readonly effective: number;
}

function readProcessUids(pid: number, procRoot = '/proc'): ProcessUids | null {
  try {
    const status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    const uids = /^Uid:\s+(?<real>\d+)\s+(?<effective>\d+)/mu.exec(status)?.groups;

    return uids === undefined
      ? null
      : { real: Number(uids['real']), effective: Number(uids['effective']) };
  } catch {
    return null;
  }
}

export function readProcessUid(pid: number, procRoot = '/proc'): number | null {
  const uids = readProcessUids(pid, procRoot);

  return uids !== null && uids.real === uids.effective ? uids.real : null;
}

export function readProcessCgroup(pid: number, procRoot = '/proc'): string | null {
  try {
    const text = readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8');

    return text.trim().replace(/^0::/u, '');
  } catch {
    return null;
  }
}

export function probeProcessOfUid(pid: number, uid: number): boolean {
  const uids = readProcessUids(pid);

  return uids !== null && (uids.real === uid || uids.effective === uid);
}

const SIGKILL = 9;

interface Pidfd {
  readonly open: (pid: number) => number;
  readonly sendSignal: (fd: number, signal: number) => number;
}

// glibc has the pidfd wrappers from 2.36
function loadPidfd(): Pidfd | null {
  const libc = readPidfdLibc();

  if (libc === null) {
    return null;
  }

  try {
    const pidfd: Pidfd = {
      open: (pid) => libc.pidfd_open(pid, 0),
      sendSignal: (fd, signal) => libc.pidfd_send_signal(fd, signal, null, 0),
    };

    // a kernel before 5.3 has the wrapper but not the syscall
    const own = pidfd.open(process.pid);

    if (own < 0) {
      return null;
    }

    closeSync(own);

    return pidfd;
  } catch {
    return null;
  }
}

let pidfd: Pidfd | null | undefined;

export function stopProcessOfUid(pid: number, uid: number): void {
  pidfd ??= loadPidfd();

  if (pidfd === null) {
    // Without a pidfd, a reused pid can still be hit.
    if (probeProcessOfUid(pid, uid)) {
      stopPid(pid);
    }

    return;
  }

  // A pidfd pins the process, so the uid read after the open belongs to the one the signal reaches.
  const fd = pidfd.open(pid);

  if (fd < 0) {
    return;
  }

  try {
    if (probeProcessOfUid(pid, uid)) {
      pidfd.sendSignal(fd, SIGKILL);
    }
  } finally {
    closeSync(fd);
  }
}
