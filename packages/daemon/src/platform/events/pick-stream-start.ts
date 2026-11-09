import type { EventCursor } from '@impz/api';

export type StreamStart =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'resume'; readonly after: number };

interface LogPosition {
  readonly head: number;
  readonly logID: string;
}

// A cursor past the head comes from another log, such as one from before a restore; a cursor the
// log pruned past shows only on the first read.
export function pickStreamStart(cursor: Readonly<EventCursor>, log: LogPosition): StreamStart {
  if (cursor.after === undefined) {
    return { kind: 'snapshot' };
  }

  const isOtherLog = cursor.logId !== undefined && cursor.logId !== log.logID;

  return isOtherLog || cursor.after > log.head
    ? { kind: 'reset' }
    : { kind: 'resume', after: cursor.after };
}
