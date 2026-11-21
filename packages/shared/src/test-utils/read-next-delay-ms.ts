import type { FakeClock } from '@zgeoff/testing/clock';

// How long until the earliest pending timer fires, or null when none is pending.
export function readNextDelayMs(clock: FakeClock): number | null {
  const dueMs = clock.readNextDueMs();

  return dueMs === null ? null : dueMs - clock.now();
}
