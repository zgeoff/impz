export interface StopSignalSource {
  readonly once: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

// a signal stops the run between rounds, so the bench still removes the imps it made
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function withStopSignal<T>(
  source: StopSignalSource,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stopper = new AbortController();

  const abort = (): void => {
    stopper.abort();
  };

  for (const signal of ENDING_SIGNALS) {
    source.once(signal, abort);
  }

  try {
    return await run(stopper.signal);
  } finally {
    for (const signal of ENDING_SIGNALS) {
      source.off(signal, abort);
    }
  }
}
