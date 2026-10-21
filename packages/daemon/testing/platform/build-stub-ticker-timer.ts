import type { TickerTimer } from '../../src/platform/process/ticker';

interface PendingRun {
  readonly run: () => Promise<void>;
  readonly durationMs: number;
}

export function buildStubTickerTimer() {
  const pending = new Map<string, PendingRun>();

  const holdRun: TickerTimer = (label, run, durationMs) => {
    const entry: PendingRun = { run, durationMs };

    pending.set(label, entry);

    return () => {
      if (pending.get(label) === entry) {
        pending.delete(label);
      }
    };
  };

  return {
    timer: holdRun,

    fire: async (label: string): Promise<void> => {
      const entry = pending.get(label);

      if (entry === undefined) {
        throw new Error(`nothing waits on a timer named ${label}`);
      }

      pending.delete(label);

      await entry.run();
    },

    readDelays: (): Record<string, number> =>
      Object.fromEntries([...pending].map(([label, entry]) => [label, entry.durationMs])),
  };
}
