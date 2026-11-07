import type { ImpEvent } from '@impz/api';
import type { ChangeSignal } from '@impz/durable';
import type { LoggedImpEvent } from '../db/imp-log-entry';
import type { ImpEventsAfter } from '../db/read-imp-events-after';
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
    let cursor = await options.readHead();

    let changed: Promise<void> | null = null;

    yield* await options.readSnapshot();

    while (!stop.signal.aborted) {
      // taken before the read, so a commit during the read still wakes the wait; kept across
      // the reads of a backlog, so each pass adds no abort listener to the signal
      changed ??= options.changes.next(stop.signal);

      const read = await options.readAfter(cursor);

      if (read.kind === 'reset') {
        return;
      }

      for (const logged of read.events) {
        const event = await options.present(logged);

        if (stop.signal.aborted) {
          return;
        }

        if (event !== null && (options.accepts?.(event) ?? true)) {
          yield event;
        }
      }

      cursor = read.throughSeq;

      if (!read.hasMore) {
        await changed;

        changed = null;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
    stop.abort();
  }
}
