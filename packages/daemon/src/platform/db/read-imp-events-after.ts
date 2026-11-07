import { readEventsAfter } from '@impz/durable';
import type { StoredEvent } from '@impz/durable';
import { getImpdLogger } from '../process/get-impd-logger';
import { ImpLogEntrySchema } from './imp-log-entry';
import type { LoggedImpEvent } from './imp-log-entry';
import type { ImpQueries } from './open-database';

export type ImpEventsAfter =
  | {
      readonly kind: 'events';
      readonly events: readonly LoggedImpEvent[];

      // the cursor for the next read: past a row this read skipped too
      readonly throughSeq: number;
      readonly hasMore: boolean;
    }
  | { readonly kind: 'reset'; readonly prunedThrough: number };

interface ReadImpEventsAfterInput {
  readonly after: number;
  readonly limit: number;
}

export async function readImpEventsAfter(
  db: ImpQueries,
  input: ReadImpEventsAfterInput,
): Promise<ImpEventsAfter> {
  const read = await readEventsAfter(db, input);

  if (read.kind === 'reset') {
    return read;
  }

  return {
    kind: 'events',
    events: read.events.flatMap((stored) => toLoggedEvents(stored)),
    throughSeq: read.events.at(-1)?.seq ?? input.after,
    hasMore: read.events.length === input.limit,
  };
}

function toLoggedEvents(stored: StoredEvent): LoggedImpEvent[] {
  const parsed = ImpLogEntrySchema.safeParse(stored.payload);

  if (!parsed.success) {
    getImpdLogger('events').warning('skipped event {seq}, a {kind} that impd cannot read', {
      seq: stored.seq,
      kind: stored.kind,
    });

    return [];
  }

  return [{ ...parsed.data, seq: stored.seq, at: new Date(stored.at) }];
}
