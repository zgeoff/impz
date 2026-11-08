import invariant from 'tiny-invariant';
import type { LoggedImpEvent } from '../../platform/db/imp-log-entry';
import type { ImpDatabase } from '../../platform/db/open-database';

// every event the log holds after the seq, read as impd's own followers read it
export async function readLoggedEvents(
  db: ImpDatabase,
  after: number,
): Promise<readonly LoggedImpEvent[]> {
  const read = await db.log.readAfter(after, 10_000);

  invariant(read.kind === 'events', `the log was pruned through ${String(after)}`);

  return read.events;
}
