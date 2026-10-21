import { FFIType, dlopen, read } from 'bun:ffi';
import type { ConvertFns, Symbols } from 'bun:ffi';

const CORE_SYMBOLS = {
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },

  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

// glibc gained the pidfd wrappers in 2.36: they load apart so the core calls
// still load on an older libc
const PIDFD_SYMBOLS = {
  pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  pidfd_send_signal: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
} as const;

type CoreLibc = ConvertFns<typeof CORE_SYMBOLS>;

type PidfdLibc = ConvertFns<typeof PIDFD_SYMBOLS>;

const opened: { core?: CoreLibc | null; pidfd?: PidfdLibc | null } = {};

export function readLibc(): CoreLibc | null {
  if (opened.core === undefined) {
    opened.core = openSymbols(CORE_SYMBOLS);
  }

  return opened.core;
}

export function readPidfdLibc(): PidfdLibc | null {
  if (opened.pidfd === undefined) {
    opened.pidfd = openSymbols(PIDFD_SYMBOLS);
  }

  return opened.pidfd;
}

export function readErrno(): number {
  // oxlint-disable-next-line no-underscore-dangle -- libc's name for the thread's errno
  const at = readLibc()?.__errno_location();

  return at === null || at === undefined ? -1 : read.i32(at);
}

function openSymbols<T extends Symbols>(symbols: T): ConvertFns<T> | null {
  try {
    return dlopen('libc.so.6', symbols).symbols;
  } catch {
    return null;
  }
}
