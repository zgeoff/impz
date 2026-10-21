import type { Clock } from './clock';
import { startRealTimer } from './start-real-timer';

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  startTimer: startRealTimer,
  sleep: (durationMs) => Bun.sleep(durationMs),
};
