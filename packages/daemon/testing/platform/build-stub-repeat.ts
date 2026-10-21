import type { Repeat } from '../../src/imps/images/build-event-stream';

export interface StubRepeat {
  readonly repeat: Repeat;
  readonly tick: (durationMs: number) => void;
  readonly countRunning: (durationMs: number) => number;
  readonly listStartedTicks: (durationMs: number) => (() => void)[];
}

export function buildStubRepeat(): StubRepeat {
  const running = new Set<{ readonly durationMs: number; readonly tick: () => void }>();

  const started: { readonly durationMs: number; readonly tick: () => void }[] = [];

  const listRunning = (durationMs: number) =>
    [...running].filter((entry) => entry.durationMs === durationMs);

  return {
    repeat: (durationMs, tick) => {
      const entry = { durationMs, tick };

      running.add(entry);
      started.push(entry);

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
    listStartedTicks: (durationMs) =>
      started.filter((entry) => entry.durationMs === durationMs).map((entry) => entry.tick),
  };
}
