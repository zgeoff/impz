import type { StartTimer } from '../../platform/process/clock';
import { buildKeyedMutex } from '../../platform/process/keyed-mutex';
import { startRealTimer } from '../../platform/process/start-real-timer';
import { DiskFullError } from './disk-full-error';
import type { StorageBackend } from './storage-backend';

const GIB = 1024 ** 3;
const RESERVE_MIN_BYTES = 5 * GIB;
const RESERVE_FRACTION = 0.05;

interface DiskStatus {
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly pendingBytes: number;
  readonly reserveBytes: number;
  readonly isLow: boolean;
}

export interface DiskBudget {
  readonly withRoom: <T>(bytes: number, task: () => Promise<T>) => Promise<T>;
  readonly withGrowingRoom: <T>(
    task: (grow: (totalBytes: number, writtenBytes: number) => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly readStatus: () => Promise<DiskStatus>;
}

interface DiskBudgetDeps {
  readonly storage: Pick<StorageBackend, 'readUsage'>;
  readonly reserveBytes: number | null;

  // ZFS shows a write's blocks in `available` only once its transaction group
  // commits, about 5 s after the write
  readonly releaseDelayMs?: number;
  readonly startTimer?: StartTimer;
  readonly log: (message: string) => void;
}

export function createDiskBudget(deps: DiskBudgetDeps): DiskBudget {
  const mutex = buildKeyedMutex();

  const startTimer: StartTimer =
    deps.startTimer ?? ((fire, durationMs) => startRealTimer(fire, durationMs, { isUnref: true }));

  const ledger = { pendingBytes: 0, wasLow: false };

  const readStatus = async (): Promise<DiskStatus> => {
    const usage = await deps.storage.readUsage();

    const sizeBytes = usage.usedBytes + usage.availableBytes;

    const reserveBytes =
      deps.reserveBytes ?? Math.max(RESERVE_MIN_BYTES, Math.round(sizeBytes * RESERVE_FRACTION));

    const free = usage.availableBytes - ledger.pendingBytes;
    const isLow = free < 2 * reserveBytes;
    const isEpisodeOver = free >= 2 * reserveBytes + GIB;

    if (isLow ? !ledger.wasLow : ledger.wasLow && isEpisodeOver) {
      ledger.wasLow = isLow;

      const message = isLow
        ? `impd: warning: low on disk: ${String(Math.round(free / GIB))} GiB free, the reserve is ${String(Math.round(reserveBytes / GIB))} GiB`
        : 'impd: disk space is back above twice the reserve';

      deps.log(message);
    }

    return { ...usage, pendingBytes: ledger.pendingBytes, reserveBytes, isLow };
  };

  const holdRoom = (bytes: number, readWrittenBytes: () => number = () => 0) =>
    mutex.runExclusive('ledger', async () => {
      const status = await readStatus();

      const free = status.availableBytes - status.pendingBytes + readWrittenBytes();

      if (free - bytes < status.reserveBytes) {
        throw new DiskFullError(Math.max(0, free), status.reserveBytes, bytes);
      }

      ledger.pendingBytes += bytes;
    });

  const removeHold = (bytes: number) => {
    const delayMs = deps.releaseDelayMs ?? 0;

    if (delayMs === 0 || bytes === 0) {
      ledger.pendingBytes -= bytes;

      return;
    }

    startTimer(() => {
      ledger.pendingBytes -= bytes;
    }, delayMs);
  };

  const withRoom = async <T>(bytes: number, task: () => Promise<T>): Promise<T> => {
    await holdRoom(bytes);

    try {
      return await task();
    } finally {
      removeHold(bytes);
    }
  };

  const withGrowingRoom = async <T>(
    task: (grow: (totalBytes: number, writtenBytes: number) => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    const held = { bytes: 0 };
    const written = { bytes: 0 };
    const readWrittenBytes = () => Math.min(held.bytes, written.bytes);

    const grow = async (totalBytes: number, writtenBytes: number) => {
      const more = totalBytes - held.bytes;

      written.bytes = writtenBytes;

      if (more > 0) {
        await holdRoom(more, readWrittenBytes);

        held.bytes += more;
      }
    };

    try {
      return await task(grow);
    } finally {
      removeHold(held.bytes);
    }
  };

  return {
    withRoom,
    withGrowingRoom,
    requireRoom: (bytes) => withRoom(bytes, () => Promise.resolve()),
    readStatus,
  };
}
