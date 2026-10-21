import { closeSync, constants, openSync, readFileSync, readSync, readlinkSync } from 'node:fs';

export const KERNEL_OOPS_TRIGGER = 'a kernel oops killed firecracker';
export const KERNEL_OOPS_REASON = 'a kernel oops';

// Taint flag D: the kernel killed a task in an oops, and only a reboot clears it.
const OOPS_TAINT = 128;

type OopsFlag = 'clear' | 'set' | 'unknown';

// An oops keeps the locks and holds its killed task had, such as a ZFS hold on
// an imp's disk, until the host reboots.
export interface KernelOopsWatch {
  readonly readFlag: () => OopsFlag;

  readonly isOopsed: () => boolean;

  readonly readOopsSeenAt: () => number | null;

  readonly readCurrentBootId: () => string | null;

  readonly readOopsOwners: (
    listOwners: (threadId: number) => readonly string[],
  ) => ReadonlySet<string> | null;
}

/* @internal */
export const NO_KERNEL_OOPS: KernelOopsWatch = {
  readFlag: () => 'clear',
  isOopsed: () => false,
  readOopsSeenAt: () => null,
  readCurrentBootId: () => null,
  readOopsOwners: () => null,
};

interface KernelLog {
  readonly kmsgPath: string;
  readonly pidNamespacePath: string;

  readonly readChunk?: (fd: number, buffer: Buffer) => number;
}

const HOST_KERNEL_LOG: KernelLog = {
  kmsgPath: '/dev/kmsg',
  pidNamespacePath: '/proc/self/ns/pid',
};

export function createKernelOopsWatch(
  path = '/proc/sys/kernel/tainted',
  now: () => number = Date.now,
  bootIdPath = '/proc/sys/kernel/random/boot_id',
  kernelLog: KernelLog = HOST_KERNEL_LOG,
): KernelOopsWatch {
  const seen: { clear: boolean; oopsedAt: number | null } = { clear: false, oopsedAt: null };
  const boot: { id: string | null } = { id: null };

  const readFlag = (): OopsFlag => {
    if (seen.oopsedAt !== null) {
      return 'set';
    }

    const taint = readTaint(path);

    if (taint === null) {
      return 'unknown';
    }

    if ((taint & OOPS_TAINT) === 0) {
      seen.clear = true;

      return 'clear';
    }

    seen.oopsedAt = now();

    return 'set';
  };

  const probeOopsed = (): boolean => readFlag() === 'set';

  const owners = new Map<number, readonly string[]>();

  return {
    readFlag,
    isOopsed: probeOopsed,
    readOopsSeenAt: () => (probeOopsed() && seen.clear ? seen.oopsedAt : null),
    readCurrentBootId: () => {
      boot.id ??= readBootId(bootIdPath);

      return boot.id;
    },
    readOopsOwners: (listOwners) => {
      // The kernel log names a thread by its host id, and inside a container's
      // PID namespace the sampler's ids are other numbers that may collide.
      if (!probeHostPidNamespace(kernelLog.pidNamespacePath)) {
        return null;
      }

      const threads = readKmsgOopsThreads(kernelLog.kmsgPath, kernelLog.readChunk ?? readSync);

      if (threads === null) {
        return null;
      }

      const found = new Set<string>();

      for (const [oops, threadId] of threads) {
        const owned = owners.get(oops) ?? listOwners(threadId);

        owners.set(oops, owned);

        if (owned.length === 0) {
          return null;
        }

        for (const impId of owned) {
          found.add(impId);
        }
      }

      return found;
    },
  };
}

function readTaint(path: string): number | null {
  let text: string;

  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }

  // Past 2^53 a JavaScript number loses its low bits, flag D among them.
  const taint = /^\d+$/v.test(text) ? Number(text) : null;

  return taint !== null && Number.isSafeInteger(taint) ? taint : null;
}

function readBootId(path: string): string | null {
  let text: string;

  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }

  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/v.test(text) ? text : null;
}

// The kernel gives the host's PID namespace this fixed inode.
const HOST_PID_NAMESPACE = 'pid:[4026531836]';

function probeHostPidNamespace(path: string): boolean {
  try {
    return readlinkSync(path) === HOST_PID_NAMESPACE;
  } catch {
    return false;
  }
}

// A kmsg record holds at most about 1 KiB of text and its dictionary.
const KMSG_READ_BYTES = 16_384;

// An oops's first line ends in its number since boot: x86 prints
// "Oops: 0000 [#1] SMP", arm64 "Internal error: Oops: 0000000096000004 [#1] SMP".
const OOPS_HEADER = /: [\da-f]{4,16} \[#(?<oops>\d+)\]/v;

// The PID on the task line is the thread's id, and kernels from 6.12 put the
// UID before it.
const OOPS_TASK = /^CPU: \d+ (?:UID: \d+ )?PID: (?<thread>\d+) Comm: /v;

// arm64 prints this line between an oops's header and its task line.
const OOPS_MODULES = 'Modules linked in:';

// A kernel warning ends with the same end marker as an oops.
const WARNING_CUT = /^-+\[ cut here \]-+$/v;
const WARNING_HEAD = 'WARNING: ';
const REPORT_END = '---[ end trace ';

interface OpenOops {
  readonly number: number;
  thread: number | null;
  isTied: boolean;
}

// The kernel drops its oldest records once the log is full, so a log that no
// longer holds every oops from the first proves nothing.
function readKmsgOopsThreads(
  path: string,
  readChunk: (fd: number, buffer: Buffer) => number,
): ReadonlyMap<number, number> | null {
  const messages = readKmsgMessages(path, readChunk);

  if (messages === null) {
    return null;
  }

  const threads = new Map<number, number | null>();

  // Another CPU's report can print between an oops's lines, so a task line is
  // the oops's only when it comes first, with no other report around it.
  let open: OpenOops | null = null;
  let openWarnings = 0;

  const writeOpenOops = (): void => {
    if (open !== null) {
      const tied = open.isTied ? open.thread : null;

      threads.set(open.number, tied);

      open = null;
    }
  };

  for (const message of messages) {
    const header = OOPS_HEADER.exec(message)?.groups?.['oops'];
    const thread = OOPS_TASK.exec(message)?.groups?.['thread'];

    if (header !== undefined) {
      if (open !== null) {
        open.isTied = false;
      }

      writeOpenOops();

      open = { number: Number(header), thread: null, isTied: openWarnings === 0 };

      threads.set(open.number, null);
    } else if (message.startsWith(REPORT_END)) {
      if (openWarnings > 0) {
        openWarnings -= 1;
      } else {
        writeOpenOops();
      }
    } else if (WARNING_CUT.test(message) || message.startsWith(WARNING_HEAD)) {
      if (message.startsWith(WARNING_HEAD)) {
        openWarnings += 1;
      }

      if (open !== null) {
        open.isTied = false;
      }
    } else if (open !== null && thread !== undefined) {
      if (open.thread === null) {
        open.thread = Number(thread);
      } else {
        open.isTied = false;
      }
    } else if (open?.thread === null && !message.startsWith(OOPS_MODULES)) {
      open.isTied = false;
    }
  }

  writeOpenOops();

  const found = new Map<number, number>();

  for (let number = 1; number <= threads.size; number += 1) {
    const thread = threads.get(number);

    if (thread === undefined || thread === null) {
      return null;
    }

    found.set(number, thread);
  }

  return found.size === 0 ? null : found;
}

// /dev/kmsg gives one "<prio>,<seq>,<usec>,<flags>;<text>" record per read and
// EAGAIN at the end, and a dictionary line under a record starts with a space.
function readKmsgMessages(
  path: string,
  readChunk: (fd: number, buffer: Buffer) => number,
): string[] | null {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }

  const buffer = Buffer.alloc(KMSG_READ_BYTES);
  const chunks: string[] = [];

  try {
    for (;;) {
      const count = readKmsgChunk(fd, buffer, readChunk);

      if (count === null) {
        return null;
      }

      if (count === 0) {
        break;
      }

      chunks.push(buffer.toString('utf8', 0, count));
    }
  } finally {
    closeSync(fd);
  }

  return chunks
    .join('')
    .split('\n')
    .filter((line) => !line.startsWith(' ') && line.includes(';'))
    .map((line) => line.slice(line.indexOf(';') + 1));
}

// EPIPE means the kernel overwrote records past this read, which may hold a
// whole oops, so the log read so far no longer proves it holds every oops.
function readKmsgChunk(
  fd: number,
  buffer: Buffer,
  readChunk: (fd: number, buffer: Buffer) => number,
): number | null {
  try {
    return readChunk(fd, buffer);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;

    return code === 'EAGAIN' ? 0 : null;
  }
}
