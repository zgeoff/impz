import type { After } from '../after';

export interface StubAfter {
  // pass as the code's `after`
  readonly after: After;

  // fires every pending timer of `ms`, as if that much time had passed; each
  // fires once
  readonly fire: (durationMs: number) => void;

  // how many timers of `ms` wait now: a test waits for its code to start one
  readonly countPending: (durationMs: number) => number;
}

// A one-shot timer the test fires by hand, in place of setTimeout: nothing
// fires until the test calls `fire`, and a cancelled timer never fires.
export function buildStubAfter(): StubAfter {
  const pending = new Set<{ readonly durationMs: number; readonly fire: () => void }>();

  const listPending = (durationMs: number) =>
    [...pending].filter((entry) => entry.durationMs === durationMs);

  return {
    after: (durationMs, fire) => {
      const entry = { durationMs, fire };

      pending.add(entry);

      return () => {
        pending.delete(entry);
      };
    },
    fire: (durationMs) => {
      for (const entry of listPending(durationMs)) {
        pending.delete(entry);
        entry.fire();
      }
    },
    countPending: (durationMs) => listPending(durationMs).length,
  };
}
