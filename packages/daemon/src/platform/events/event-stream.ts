import type { ImpEvent } from '@impz/api';
import type { ChangeSignal } from '@impz/durable';
import type { LoggedImpEvent } from '../db/imp-log-entry';
import type { ImpEventsAfter } from '../db/read-imp-events-after';
import { tailImpEvents } from '../db/tail-imp-events';
import type { StartTimer } from '../process/clock';
import { startTimerAt } from '../process/start-timer-at';

interface EventStreamOptions {
  readonly changes: ChangeSignal;
  readonly readHead: () => Promise<number>;
  readonly readAfter: (after: number) => Promise<ImpEventsAfter>;

  readonly readSnapshot: () => Promise<readonly ImpEvent[]>;
  readonly present: (event: LoggedImpEvent) => Promise<ImpEvent | null>;
  readonly signal?: AbortSignal | undefined;

  readonly endsAt: number | null;
  readonly now: () => number;

  readonly startTimer?: StartTimer;

  readonly accepts?: (event: ImpEvent) => boolean;
}

// The stream reads the log at its own pace, so a slow reader falls behind and never loses an
// event; a prune that passes its cursor ends it.
export async function* openEventStream(options: EventStreamOptions): AsyncGenerator<ImpEvent> {
  const stop = new AbortController();

  const stopStream = (): void => {
    stop.abort();
  };

  options.signal?.addEventListener('abort', stopStream);

  const cancelTimer =
    options.endsAt === null
      ? null
      : startTimerAt(stopStream, options.endsAt, {
          now: options.now,
          ...(options.startTimer !== undefined && { startTimer: options.startTimer }),
        });

  try {
    const head = await options.readHead();

    yield* await options.readSnapshot();

    const pages = tailImpEvents({
      changes: options.changes,
      readAfter: options.readAfter,
      after: head,
      signal: stop.signal,
    });

    for await (const page of pages) {
      for (const logged of page) {
        const event = await options.present(logged);

        if (stop.signal.aborted) {
          return;
        }

        if (event !== null && (options.accepts?.(event) ?? true)) {
          yield event;
        }
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
    stop.abort();
  }
}
