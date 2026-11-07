import type { EventCursor, EventPage, ImpEvent } from '@impz/api';
import { match } from 'ts-pattern';
import { buildResetEvent } from './build-reset-event';
import type { EventLogReads } from './event-stream';
import { pickStreamStart } from './pick-stream-start';

// A page with no usable cursor holds the snapshot, after a reset when the reader sent a cursor.
export async function readEventPage(
  reads: EventLogReads,
  cursor: Readonly<EventCursor>,
  limit: number,
): Promise<EventPage> {
  const logId = await reads.readLogId();
  const head = await reads.readHead();

  return match(pickStreamStart(cursor, { head, logId }))
    .with({ kind: 'snapshot' }, () => readSnapshotPage(reads, { head, logId, isReset: false }))
    .with({ kind: 'reset' }, () => readSnapshotPage(reads, { head, logId, isReset: true }))
    .with({ kind: 'resume' }, (resume) =>
      readResumedPage(reads, { head, logId, isReset: false }, resume.after, limit),
    )
    .exhaustive();
}

interface SnapshotPosition {
  readonly head: number;
  readonly logId: string;
  readonly isReset: boolean;
}

async function readSnapshotPage(
  reads: EventLogReads,
  position: SnapshotPosition,
): Promise<EventPage> {
  const snapshot = await reads.readSnapshot(position.head, position.logId);

  const reset = position.isReset
    ? [buildResetEvent({ seq: position.head, logId: position.logId, at: reads.now() })]
    : [];

  return {
    events: [...reset, ...snapshot],
    after: position.head,
    logId: position.logId,
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
    const event = await reads.present(logged, position.logId);

    if (event !== null && (reads.accepts?.(event) ?? true)) {
      events.push(event);
    }
  }

  return { events, after: read.throughSeq, logId: position.logId, hasMore: read.hasMore };
}
