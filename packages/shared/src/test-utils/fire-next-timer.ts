import type { FakeClock } from '@zgeoff/testing/clock';

// Moves the clock to the earliest pending timer, so that it fires, and does nothing when none is
// pending.
export function fireNextTimer(clock: FakeClock): void {
  const dueMs = clock.readNextDueMs();

  if (dueMs !== null) {
    clock.advance(dueMs - clock.now());
  }
}
