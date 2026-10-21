import type { ImpEvent } from '@impz/api';
import type { StartTimer } from '../process/clock';
import { startTimerAt } from '../process/start-timer-at';
import type { EventBus } from './event-bus';

const QUEUE_LIMIT = 1000;

interface EventStreamOptions {
  readonly bus: EventBus;

  readonly readSnapshot: () => Promise<readonly ImpEvent[]>;
  readonly signal?: AbortSignal | undefined;

  readonly endsAt: number | null;
  readonly now: () => number;

  readonly startTimer?: StartTimer;
  readonly queueLimit?: number;

  readonly accepts?: (event: ImpEvent) => boolean;
}

export async function* openEventStream(options: EventStreamOptions): AsyncGenerator<ImpEvent> {
  const limit = options.queueLimit ?? QUEUE_LIMIT;
  const queue: ImpEvent[] = [];
  const state = { ended: false, wake: (): void => {} };

  const stopStream = (): void => {
    state.ended = true;

    state.wake();
  };

  const unsubscribe = options.bus.subscribe((event) => {
    if (options.accepts !== undefined && !options.accepts(event)) {
      return;
    }

    if (queue.length >= limit) {
      stopStream();

      return;
    }

    queue.push(event);
    state.wake();
  });

  options.signal?.addEventListener('abort', stopStream);

  const cancelTimer =
    options.endsAt === null
      ? null
      : startTimerAt(stopStream, options.endsAt, {
          now: options.now,
          ...(options.startTimer !== undefined && { startTimer: options.startTimer }),
        });

  try {
    const snapshot = await options.readSnapshot();

    yield* snapshot;

    for (;;) {
      const next = queue.shift();

      if (state.ended) {
        return;
      }

      if (next !== undefined) {
        yield next;
        continue;
      }

      const waiting = Promise.withResolvers<undefined>();

      state.wake = () => {
        waiting.resolve(undefined);
      };

      await waiting.promise;
    }
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
  }
}
