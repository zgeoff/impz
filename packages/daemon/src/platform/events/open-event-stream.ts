import type { EventCursor, ImpEvent } from '@impz/api';
import type { ChangeSignal } from '@impz/durable';
import { match } from 'ts-pattern';
import type { LoggedImpEvent } from '../db/imp-log-entry';
import type { ImpEventsAfter } from '../db/read-imp-events-after';
import { tailImpEvents } from '../db/tail-imp-events';
import type { ImpEventsReset } from '../db/tail-imp-events';
import type { StartTimer } from '../process/clock';
import { startTimerAt } from '../process/start-timer-at';
import { buildCursorEvent } from './build-cursor-event';
import { pickStreamStart } from './pick-stream-start';

export interface EventLogReads {
  readonly readHead: () => Promise<number>;
  readonly readLogID: () => Promise<string>;
  readonly readAfter: (after: number, limit: number) => Promise<ImpEventsAfter>;

  readonly readSnapshot: (head: number, logID: string) => Promise<readonly ImpEvent[]>;
  readonly present: (event: LoggedImpEvent, logID: string) => Promise<ImpEvent | null>;
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
    const logID = await options.readLogID();
    const head = await options.readHead();

    const start = pickStreamStart(options.cursor, { head, logID });

    const opening = match(start)
      .with({ kind: 'snapshot' }, () => ({ isReset: false, hasSnapshot: true, after: head }))
      .with({ kind: 'reset' }, () => ({ isReset: true, hasSnapshot: true, after: head }))
      .with({ kind: 'resume' }, (resume) => ({
        isReset: false,
        hasSnapshot: false,
        after: resume.after,
      }))
      .exhaustive();

    if (opening.isReset) {
      yield buildCursorEvent('Reset', { seq: head, logID, at: options.now() });
    }

    // a reader that opened with no cursor may be a client that knows no Reset or Position, and
    // an unknown event kind fails its stream
    const knowsCursorEvents = options.cursor.after !== undefined;

    if (opening.hasSnapshot) {
      yield* readSnapshotAt(options, { head, logID, knowsCursorEvents });
    }

    let after = opening.after;

    while (!stop.signal.aborted) {
      const pages = tailImpEvents({
        changes: options.changes,
        readAfter: (cursor) => options.readAfter(cursor, READ_LIMIT),
        after,
        signal: stop.signal,
      });

      const reset = yield* presentPages(pages, options, {
        logID,
        knowsCursorEvents,
        signal: stop.signal,
      });

      // a reader with no cursor gets no Reset, so its stream ends here, and its reconnect takes
      // the snapshot
      if (reset === null || !knowsCursorEvents) {
        return;
      }

      after = await options.readHead();

      yield buildCursorEvent('Reset', { seq: after, logID, at: options.now() });
      yield* readSnapshotAt(options, { head: after, logID, knowsCursorEvents });
    }
  } finally {
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
    stop.abort();
  }
}

interface StreamPlace {
  readonly logID: string;
  readonly knowsCursorEvents: boolean;
}

// The snapshot ends with the head it was read at, so a reader that sees no imp still has a cursor.
async function* readSnapshotAt(
  reads: EventLogReads,
  place: Readonly<StreamPlace & { head: number }>,
): AsyncGenerator<ImpEvent> {
  yield* await reads.readSnapshot(place.head, place.logID);

  if (place.knowsCursorEvents) {
    yield buildCursorEvent('Position', { seq: place.head, logID: place.logID, at: reads.now() });
  }
}

async function* presentPages(
  pages: AsyncGenerator<readonly LoggedImpEvent[], ImpEventsReset | null>,
  reads: EventLogReads,
  place: Readonly<StreamPlace & { signal: AbortSignal }>,
): AsyncGenerator<ImpEvent, ImpEventsReset | null> {
  const logID = place.logID;
  const signal = place.signal;

  try {
    let step = await pages.next();

    while (step.done !== true) {
      let sentSeq: number | null = null;

      for (const logged of step.value) {
        const event = await reads.present(logged, logID);

        if (signal.aborted) {
          return null;
        }

        if (event !== null && (reads.accepts?.(event) ?? true)) {
          sentSeq = logged.seq;
          yield event;
        }
      }

      const readSeq = step.value.at(-1)?.seq ?? null;

      if (place.knowsCursorEvents && readSeq !== null && readSeq !== sentSeq) {
        yield buildCursorEvent('Position', { seq: readSeq, logID, at: reads.now() });
      }

      step = await pages.next();
    }

    return step.value;
  } finally {
    await pages.return(null);
  }
}
