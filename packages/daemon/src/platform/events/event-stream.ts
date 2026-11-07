import type { EventCursor, ImpEvent } from '@impz/api';
import type { ChangeSignal } from '@impz/durable';
import type { LoggedImpEvent } from '../db/imp-log-entry';
import type { ImpEventsAfter } from '../db/read-imp-events-after';
import { tailImpEvents } from '../db/tail-imp-events';
import type { StartTimer } from '../process/clock';
import { startTimerAt } from '../process/start-timer-at';
import { buildResetEvent } from './build-reset-event';
import { pickStreamStart } from './pick-stream-start';

export interface EventLogReads {
  readonly readHead: () => Promise<number>;
  readonly readLogId: () => Promise<string>;
  readonly readAfter: (after: number, limit: number) => Promise<ImpEventsAfter>;

  readonly readSnapshot: (head: number, logId: string) => Promise<readonly ImpEvent[]>;
  readonly present: (event: LoggedImpEvent, logId: string) => Promise<ImpEvent | null>;
  readonly accepts?: (event: ImpEvent) => boolean;

  readonly now: () => number;
}

interface EventStreamOptions extends EventLogReads {
  readonly cursor: Readonly<EventCursor>;
  readonly changes: ChangeSignal;
  readonly signal?: AbortSignal | undefined;

  readonly endsAt: number | null;

  readonly startTimer?: StartTimer;
}

const READ_LIMIT = 500;

// The stream reads the log at its own pace, so a slow reader falls behind and never loses an
// event; a prune that passes its cursor sends a reset and a new snapshot.
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
    const logId = await options.readLogId();
    const head = await options.readHead();

    const start = pickStreamStart(options.cursor, { head, logId });

    if (start.kind === 'reset') {
      yield buildResetEvent({ seq: head, logId, at: options.now() });
    }

    if (start.kind !== 'resume') {
      yield* await options.readSnapshot(head, logId);
    }

    let after = start.kind === 'resume' ? start.after : head;

    while (!stop.signal.aborted) {
      const pages = tailImpEvents({
        changes: options.changes,
        readAfter: (cursor) => options.readAfter(cursor, READ_LIMIT),
        after,
        signal: stop.signal,
      });

      try {
        let step = await pages.next();

        while (step.done !== true) {
          for (const logged of step.value) {
            const event = await options.present(logged, logId);

            if (stop.signal.aborted) {
              return;
            }

            if (event !== null && (options.accepts?.(event) ?? true)) {
              yield event;
            }
          }

          step = await pages.next();
        }

        if (step.value === null) {
          return;
        }
      } finally {
        await pages.return(null);
      }

      // a reader that opened with no cursor may know no Reset, so its stream ends as it always
      // has, and its reconnect takes the snapshot
      if (options.cursor.after === undefined) {
        return;
      }

      after = await options.readHead();

      yield buildResetEvent({ seq: after, logId, at: options.now() });
      yield* await options.readSnapshot(after, logId);
    }
  } finally {
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
    stop.abort();
  }
}
