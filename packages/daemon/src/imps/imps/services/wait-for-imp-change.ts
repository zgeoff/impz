import type { ImpEvent } from '@impz/api';
import type { EventBus } from '../../../platform/events/event-bus';
import type { StartTimer } from '../../../platform/process/clock';

export function waitForImpChange(
  context: Readonly<{ events: Pick<EventBus, 'subscribe'>; startTimer: StartTimer }>,
  name: string,
  signal: Readonly<AbortSignal>,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  const waiting = Promise.withResolvers<void>();

  const stopWaiting = (): void => {
    cancelTimer();
    unsubscribe();

    signal.removeEventListener('abort', stopWaiting);
    waiting.resolve();
  };

  const unsubscribe = context.events.subscribe((event: Readonly<ImpEvent>) => {
    if ('imp' in event && event.imp.name === name) {
      stopWaiting();
    }
  });

  const cancelTimer = context.startTimer(stopWaiting, timeoutMs);

  signal.addEventListener('abort', stopWaiting, { once: true });

  return waiting.promise;
}
