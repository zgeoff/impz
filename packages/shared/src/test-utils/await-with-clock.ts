import type { FakeClock } from '@zgeoff/testing/clock';
import { runClockUntil } from '@zgeoff/testing/clock';

// Waits for work that sleeps on the fake clock, moving the clock to each sleep in turn, and returns
// what the work returned or throws what it threw. It throws when the work has not settled after
// maxMs of clock time. Work that awaits real I/O with no timer set is waited for in real time.
export async function awaitWithClock<T>(
  clock: FakeClock,
  work: Promise<T>,
  maxMs = 3_600_000,
): Promise<T> {
  const state = { isSettled: false };

  const watching = (async () => {
    await Promise.allSettled([work]);

    state.isSettled = true;
  })();

  const startMs = clock.now();

  while (!state.isSettled) {
    try {
      await runClockUntil(clock, () => state.isSettled, {
        maxMs: maxMs - (clock.now() - startMs),
      });
    } catch (error) {
      if (!isIdleError(error)) {
        throw error;
      }

      await Bun.sleep(1);
    }
  }

  await watching;

  return work;
}

function isIdleError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('nothing is scheduled');
}
