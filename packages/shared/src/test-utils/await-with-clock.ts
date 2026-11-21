import type { FakeClock } from '@zgeoff/testing/clock';
import { runClockUntil } from '@zgeoff/testing/clock';

// Waits for work that sleeps on the fake clock, moving the clock to each sleep in turn, and returns
// what the work returned or throws what it threw. It throws when the work has not settled after
// maxMs of clock time.
export async function awaitWithClock<T>(
  clock: FakeClock,
  work: Promise<T>,
  maxMs = 3_600_000,
): Promise<T> {
  let isSettled = false;

  const watching = (async () => {
    await Promise.allSettled([work]);

    isSettled = true;
  })();

  await runClockUntil(clock, () => isSettled, { maxMs });
  await watching;

  return work;
}
