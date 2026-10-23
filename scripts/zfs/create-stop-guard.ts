import { StopError } from './stop-error.ts';
import type { ZfsChild, ZfsIO, ZfsSignal } from './types.ts';

export interface StopGuard {
  // The exit code of the first signal, or null before one comes.
  readonly findStopCode: () => number | null;
  readonly throwIfStopped: () => void;

  // Waits for the child, and stops it first when a signal comes while it runs.
  readonly runChild: (child: ZfsChild) => Promise<number>;
}

const EXIT_CODES: Readonly<Record<ZfsSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

// A signal never runs the cleanup itself: as a bash trap does, it waits for the step that runs, and
// the run's own cleanup follows once that step returns.
export function createStopGuard(io: Pick<ZfsIO, 'onSignal'>): StopGuard {
  let stopCode: number | null = null;
  let running: ZfsChild | null = null;

  const stop = (signal: ZfsSignal) => {
    stopCode ??= EXIT_CODES[signal];
    running?.kill('SIGTERM');
  };

  io.onSignal('SIGINT', () => {
    stop('SIGINT');
  });

  io.onSignal('SIGTERM', () => {
    stop('SIGTERM');
  });

  return {
    findStopCode: () => stopCode,
    throwIfStopped: () => {
      if (stopCode !== null) {
        throw new StopError(stopCode);
      }
    },
    runChild: async (child) => {
      running = child;

      if (stopCode !== null) {
        child.kill('SIGTERM');
      }

      try {
        return await child.exited;
      } finally {
        running = null;
      }
    },
  };
}
