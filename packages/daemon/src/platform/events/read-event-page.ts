import type { EventCursor, EventPage, ImpEvent } from '@impz/api';
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

  const start = pickStreamStart(cursor, { head, logId });

  if (start.kind !== 'resume') {
    return readSnapshotPage(reads, { head, logId, isReset: start.kind === 'reset' });
  }

  const read = await reads.readAfter(start.after, limit);

  if (read.kind === 'reset') {
    return readSnapshotPage(reads, { head, logId, isReset: true });
  }

  const events: ImpEvent[] = [];

  for (const logged of read.events) {
    const event = await reads.present(logged, logId);

    if (event !== null && (reads.accepts?.(event) ?? true)) {
      events.push(event);
    }
  }

  return { events, after: read.throughSeq, logId, hasMore: read.hasMore };
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
