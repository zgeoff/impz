import type { Clock } from '@zgeoff/std';
import type { FakeClock } from '@zgeoff/testing/clock';

// The fake clock as code sees it when each sleep moves the clock by its whole wait and returns at
// once. A test uses it for code that sleeps deep in a system it cannot wrap in awaitWithClock, and
// reads the sleeps from the delays of the fake clock.
export function buildAdvancingClock(clock: FakeClock): Pick<Clock, 'now' | 'sleep'> {
  return {
    now: clock.now,
    sleep: (delayMs, signal) => {
      const slept = clock.sleep(delayMs, signal);

      clock.advance(delayMs);

      return slept;
    },
  };
}
