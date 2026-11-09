import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';

interface CursorPosition {
  readonly seq: number;
  readonly logID: string;
  readonly at: number;
}

// an event that names a place in the log and no imp: a reset, or how far the stream has read
export function buildCursorEvent(ev: 'Reset' | 'Position', position: CursorPosition): ImpEvent {
  return {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(position.at),
    seq: position.seq,
    logId: position.logID,
    ev,
  };
}
