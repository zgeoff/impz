import type { After } from '../after';

export interface StubAfter {
  readonly after: After;
  readonly fire: (durationMs: number) => void;
  readonly countPending: (durationMs: number) => number;
}

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
