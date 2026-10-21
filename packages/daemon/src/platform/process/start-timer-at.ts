import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

// setTimeout's longest delay: a longer one overflows, warns, and fires at once
const MAX_DELAY_MS = 2 ** 31 - 1;

interface TimerAtOptions {
  readonly now: () => number;

  readonly startTimer?: StartTimer;
}

export function startTimerAt(
  fire: () => void,
  at: number,
  options: Readonly<TimerAtOptions>,
): () => void {
  const startTimer = options.startTimer ?? startRealTimer;
  let stopStep: () => void = stopNothing;

  const startStep = (): void => {
    const remaining = Number.isFinite(at) ? at - options.now() : 0;

    if (remaining <= MAX_DELAY_MS) {
      stopStep = startTimer(fire, Math.max(0, remaining));

      return;
    }

    stopStep = startTimer(startStep, MAX_DELAY_MS);
  };

  startStep();

  return () => {
    stopStep();
  };
}

function stopNothing(): void {}
