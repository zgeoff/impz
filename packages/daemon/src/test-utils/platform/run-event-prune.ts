import { pruneEvents } from '@impz/durable';
import type { ImpDatabase } from '../../platform/db/open-database';
import { withImpTransaction } from '../../platform/db/with-imp-transaction';

// the prune the event log's reconciler runs, at a time the test picks
export function runEventPrune(db: ImpDatabase, now: number): Promise<number> {
  return withImpTransaction(db, (trx) => pruneEvents(trx, now));
}
