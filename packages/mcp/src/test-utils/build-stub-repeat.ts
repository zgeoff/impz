import type { Repeat } from '../repeat';

export interface StubRepeat {
  // pass as the code's `repeat`
  readonly repeat: Repeat;

  // runs once every running repeat of `ms`, as if that much time had passed
  readonly tick: (durationMs: number) => void;

  // how many repeats of `ms` run now: a test waits for its code to start one
  readonly countRunning: (durationMs: number) => number;
}

// A timer the test steps by hand, in place of setInterval: nothing ticks
// until the test calls `tick`, and a stopped repeat never ticks again.
export function buildStubRepeat(): StubRepeat {
  const running = new Set<{ readonly durationMs: number; readonly tick: () => void }>();

  const listRunning = (durationMs: number) =>
    [...running].filter((entry) => entry.durationMs === durationMs);

  return {
    repeat: (durationMs, tick) => {
      const entry = { durationMs, tick };

      running.add(entry);

      return () => {
        running.delete(entry);
      };
    },
    tick: (durationMs) => {
      for (const entry of listRunning(durationMs)) {
        entry.tick();
      }
    },
    countRunning: (durationMs) => listRunning(durationMs).length,
  };
}
