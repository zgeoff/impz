import { getErrorMessage } from './get-error-message';

export interface Ticker {
  readonly stop: () => Promise<void>;
}

export type TickerTimer = (
  label: string,
  run: () => Promise<void>,
  durationMs: number,
) => () => void;

export interface StartTickerOptions {
  readonly label: string;
  readonly intervalMs: number;
  readonly firstDelayMs?: number | undefined;
  readonly task: () => Promise<void>;
  readonly log: (message: string) => void;
  readonly timer?: TickerTimer | undefined;
}

export function startTicker(options: StartTickerOptions): Ticker {
  const label = options.label;
  const intervalMs = options.intervalMs;
  const task = options.task;
  const log = options.log;
  const timer = options.timer ?? startRuntimeTimer;

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
      setupNextTick(intervalMs);
    }
  };

  const setupNextTick = (delayMs: number): void => {
    state.cancel = timer(
      label,
      () => {
        const running = runAndReschedule();

        state.running = running;

        return running;
      },
      delayMs,
    );
  };

  setupNextTick(options.firstDelayMs ?? intervalMs);

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
