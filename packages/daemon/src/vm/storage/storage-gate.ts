import type { Clock } from '../../platform/process/clock';
import type { TryResult } from '../../platform/process/keyed-mutex';
import { REAL_CLOCK } from '../../platform/process/real-clock';

// Every operation that can make storage before its rows commit runs in `join`,
// so the GC never sweeps that storage as an orphan.
export interface StorageGate {
  readonly join: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runAlone: <T>(task: () => Promise<T>, timeoutMs: number) => Promise<TryResult<T>>;
  readonly countInFlight: () => number;
  readonly countWaiting: () => number;
}

export function createStorageGate(
  clock: Pick<Clock, 'now' | 'startTimer'> = REAL_CLOCK,
): StorageGate {
  const state = {
    inFlight: 0,
    waiting: 0,
    alone: null as Promise<void> | null,
    idle: Promise.withResolvers<void>(),
  };

  const runJoined = async <T>(task: () => Promise<T>): Promise<T> => {
    while (state.alone !== null) {
      await state.alone;
    }

    state.inFlight += 1;

    try {
      return await task();
    } finally {
      state.inFlight -= 1;

      if (state.inFlight === 0) {
        state.idle.resolve();

        state.idle = Promise.withResolvers<void>();
      }
    }
  };

  const queue = { tail: Promise.resolve() };

  const runAlone = async <T>(task: () => Promise<T>, timeoutMs: number): Promise<TryResult<T>> => {
    const previous = queue.tail;
    const done = Promise.withResolvers<void>();

    queue.tail = done.promise;

    try {
      await previous;

      const deadline = clock.now() + timeoutMs;

      state.waiting += 1;

      try {
        // no await sits between the last check and the claim, so no join slips in between
        while (state.inFlight > 0) {
          const left = deadline - clock.now();

          if (left <= 0) {
            return { ran: false };
          }

          const expired = Promise.withResolvers<void>();

          const cancel = clock.startTimer(() => {
            expired.resolve();
          }, left);

          try {
            await Promise.race([state.idle.promise, expired.promise]);
          } finally {
            cancel();
          }
        }
      } finally {
        state.waiting -= 1;
      }

      state.alone = done.promise;

      return { ran: true, value: await task() };
    } finally {
      state.alone = null;

      done.resolve();
    }
  };

  return {
    join: runJoined,
    runAlone,
    countInFlight: () => state.inFlight,
    countWaiting: () => state.waiting,
  };
}
