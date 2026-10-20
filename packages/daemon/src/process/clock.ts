// starts a timer that calls `fire` once after `ms`, and returns its cancel
export type StartTimer = (fire: () => void, durationMs: number) => () => void;

// impd's one time port: a unit that reads the time, waits, or starts timers
// takes the parts it needs, and a test passes buildStubClock's
export interface Clock {
  // milliseconds since the epoch
  readonly now: () => number;
  readonly startTimer: StartTimer;
  readonly sleep: (durationMs: number) => Promise<void>;
}
