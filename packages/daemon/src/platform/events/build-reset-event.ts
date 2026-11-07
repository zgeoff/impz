import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';

interface ResetPosition {
  readonly seq: number;
  readonly logId: string;
  readonly at: number;
}

export function buildResetEvent(position: ResetPosition): ImpEvent {
  return {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(position.at),
    seq: position.seq,
    logId: position.logId,
    ev: 'Reset',
  };
}
