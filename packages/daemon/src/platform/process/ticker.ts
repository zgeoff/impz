import { getErrorMessage } from './get-error-message';

export interface Ticker {
  readonly stop: () => Promise<void>;
}

export type TickerTimer = (
  label: string,
  run: () => Promise<void>,
  durationMs: number,
) => () => void;

export function startTicker(
  label: string,
  intervalMs: number,
  task: () => Promise<void>,
  log: (message: string) => void,
  timer: TickerTimer = startRuntimeTimer,
): Ticker {
  const state: { cancel: (() => void) | null; running: Promise<void> | null } = {
    cancel: null,
    running: null,
  };

  let stopped = false;

  const runTick = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      log(`impd: ${label}: ${getErrorMessage(error)}`);
    }
  };

  const runAndReschedule = async (): Promise<void> => {
    await runTick();

    state.running = null;

    if (!stopped) {
      setupNextTick();
    }
  };

  const setupNextTick = (): void => {
    state.cancel = timer(
      label,
      () => {
        const running = runAndReschedule();

        state.running = running;

        return running;
      },
      intervalMs,
    );
  };

  setupNextTick();

  return {
    stop: async () => {
      stopped = true;
      state.cancel?.();

      await state.running;
    },
  };
}

function startRuntimeTimer(
  _label: string,
  run: () => Promise<void>,
  durationMs: number,
): () => void {
  const handle = setTimeout(() => {
    void run();
  }, durationMs);

  return () => {
    clearTimeout(handle);
  };
}
