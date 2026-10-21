import type { Clock } from '../../src/platform/process/clock';

interface StubTimer {
  readonly at: number;
  readonly durationMs: number;
  readonly fire: () => void;
}

export function buildStubClock(options: Readonly<{ startMs?: number }> = {}) {
  const state = { nowMs: options.startMs ?? 0, nextId: 0 };

  const pending = new Map<number, StubTimer>();

  const delays: number[] = [];
  const sleeps: number[] = [];

  const runFor = (durationMs: number): void => {
    const until = state.nowMs + durationMs;

    for (;;) {
      const [due] = [...pending]
        .filter(([, timer]) => timer.at <= until)
        .toSorted(([, left], [, right]) => left.at - right.at);

      if (due === undefined) {
        break;
      }

      const [id, timer] = due;

      pending.delete(id);

      state.nowMs = Math.max(state.nowMs, timer.at);

      timer.fire();
    }

    state.nowMs = until;
  };

  const startTimer = (fire: () => void, durationMs: number): (() => void) => {
    state.nextId += 1;

    const id = state.nextId;

    delays.push(durationMs);
    pending.set(id, { at: state.nowMs + durationMs, durationMs, fire });

    return () => {
      pending.delete(id);
    };
  };

  const sleep = (durationMs: number): Promise<void> => {
    sleeps.push(durationMs);

    runFor(durationMs);

    return Promise.resolve();
  };

  const clock: Clock = { now: () => state.nowMs, startTimer, sleep };

  return {
    ...clock,
    delays,
    sleeps,
    runFor,

    firePending: (): void => {
      const pendingNow = [...pending];

      for (const [id, timer] of pendingNow) {
        if (pending.delete(id)) {
          timer.fire();
        }
      }
    },

    readPendingMs: (): number[] => [...pending.values()].map((timer) => timer.durationMs),

    countPending: (): number => pending.size,
  };
}
