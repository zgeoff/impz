import type { EventCursor, EventPage, ImpEvent } from '@impz/api';
import { match } from 'ts-pattern';
import { buildCursorEvent } from './build-cursor-event';
import type { EventLogReads } from './event-stream';
import { pickStreamStart } from './pick-stream-start';

// A page with no usable cursor holds the snapshot, after a reset when the reader sent a cursor.
export async function readEventPage(
  reads: EventLogReads,
  cursor: Readonly<EventCursor>,
  limit: number,
): Promise<EventPage> {
  const logID = await reads.readLogID();
  const head = await reads.readHead();

  return match(pickStreamStart(cursor, { head, logID }))
    .with({ kind: 'snapshot' }, () => readSnapshotPage(reads, { head, logID, isReset: false }))
    .with({ kind: 'reset' }, () => readSnapshotPage(reads, { head, logID, isReset: true }))
    .with({ kind: 'resume' }, (resume) =>
      readResumedPage(reads, { head, logID, isReset: false }, resume.after, limit),
    )
    .exhaustive();
}

interface SnapshotPosition {
  readonly head: number;
  readonly logID: string;
  readonly isReset: boolean;
}

async function readSnapshotPage(
  reads: EventLogReads,
  position: SnapshotPosition,
): Promise<EventPage> {
  const snapshot = await reads.readSnapshot(position.head, position.logID);

  const reset = position.isReset
    ? [buildCursorEvent('Reset', { seq: position.head, logID: position.logID, at: reads.now() })]
    : [];

  return {
    events: [...reset, ...snapshot],
    after: position.head,
    logId: position.logID,
    hasMore: false,
  };
}

async function readResumedPage(
  reads: EventLogReads,
  position: SnapshotPosition,
  after: number,
  limit: number,
): Promise<EventPage> {
  const read = await reads.readAfter(after, limit);

  if (read.kind === 'reset') {
    return readSnapshotPage(reads, { ...position, isReset: true });
  }

  const events: ImpEvent[] = [];

  for (const logged of read.events) {
    const event = await reads.present(logged, position.logID);

    if (event !== null && (reads.accepts?.(event) ?? true)) {
      events.push(event);
    }
  }

  return { events, after: read.throughSeq, logId: position.logID, hasMore: read.hasMore };
}
