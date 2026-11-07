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
      yield buildCursorEvent('Reset', { seq: head, logId, at: options.now() });
    }

    if (opening.hasSnapshot) {
      yield* readSnapshotAt(options, head, logId);
    }

    let after = opening.after;

    while (!stop.signal.aborted) {
      const pages = tailImpEvents({
        changes: options.changes,
        readAfter: (cursor) => options.readAfter(cursor, READ_LIMIT),
        after,
        signal: stop.signal,
      });

      const reset = yield* presentPages(pages, options, logId, stop.signal);

      if (reset === null) {
        return;
      }

      // a reader that opened with no cursor may know no Reset, so its stream ends here, and its
      // reconnect takes the snapshot
      if (options.cursor.after === undefined) {
        return;
      }

      after = await options.readHead();

      yield buildCursorEvent('Reset', { seq: after, logId, at: options.now() });
      yield* readSnapshotAt(options, after, logId);
    }
  } finally {
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
    stop.abort();
  }
}

// The snapshot ends with the head it was read at, so a reader that sees no imp still has a cursor.
async function* readSnapshotAt(
  reads: EventLogReads,
  head: number,
  logId: string,
): AsyncGenerator<ImpEvent> {
  yield* await reads.readSnapshot(head, logId);
  yield buildCursorEvent('Position', { seq: head, logId, at: reads.now() });
}

// Yields each event of the tail's pages that the reader may see, then a position past the events
// of a page that the reader may not see, so its cursor moves past them. It returns the tail's
// reset, or null once the stream stops.
async function* presentPages(
  pages: AsyncGenerator<readonly LoggedImpEvent[], ImpEventsReset | null>,
  reads: EventLogReads,
  logId: string,
  signal: AbortSignal,
): AsyncGenerator<ImpEvent, ImpEventsReset | null> {
  try {
    let step = await pages.next();

    while (step.done !== true) {
      let sentSeq: number | null = null;

      for (const logged of step.value) {
        const event = await reads.present(logged, logId);

        if (signal.aborted) {
          return null;
        }

        if (event !== null && (reads.accepts?.(event) ?? true)) {
          sentSeq = logged.seq;
          yield event;
        }
      }

      const readSeq = step.value.at(-1)?.seq ?? null;

      if (readSeq !== null && readSeq !== sentSeq) {
        yield buildCursorEvent('Position', { seq: readSeq, logId, at: reads.now() });
      }

      step = await pages.next();
    }

    return step.value;
  } finally {
    await pages.return(null);
  }
}
