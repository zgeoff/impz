interface StubTimer {
  readonly at: number;
  readonly delayMs: number;
  readonly fire: () => void;
}

export function buildStubClock(startMs: number) {
  const state = { nowMs: startMs, nextId: 0 };

  const pending = new Map<number, StubTimer>();

  return {
    now: (): number => state.nowMs,

    startTimer: (fire: () => void, delayMs: number): (() => void) => {
      state.nextId += 1;

      const id = state.nextId;

      pending.set(id, { at: state.nowMs + delayMs, delayMs, fire });

      return () => {
        pending.delete(id);
      };
    },

    runFor: (durationMs: number): void => {
      const until = state.nowMs + durationMs;

      for (;;) {
        const [due] = [...pending]
          .filter((entry) => entry[1].at <= until)
          .toSorted((left, right) => left[1].at - right[1].at);

        if (due === undefined) {
          break;
        }

        pending.delete(due[0]);

        state.nowMs = Math.max(state.nowMs, due[1].at);

        due[1].fire();
      }

      state.nowMs = until;
    },

    readPendingMs: (): number[] => [...pending.values()].map((timer) => timer.delayMs),
  };
}
