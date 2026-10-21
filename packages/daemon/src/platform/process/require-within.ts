import type { StartTimer } from './clock';
import { startRealTimer } from './start-real-timer';

export async function requireWithin<T>(
  promise: Promise<T>,
  durationMs: number,
  buildError: () => Error,
  startTimer: StartTimer = startRealTimer,
): Promise<T> {
  const timer = Promise.withResolvers<never>();

  const cancel = startTimer(() => {
    timer.reject(buildError());
  }, durationMs);

  try {
    return await Promise.race([promise, timer.promise]);
  } finally {
    cancel();
  }
}
