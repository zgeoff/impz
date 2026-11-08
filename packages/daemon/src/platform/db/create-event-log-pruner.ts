import { defineReconciler, pruneEvents } from '@impz/durable';
import type { ReconcilerDefinition } from '@impz/durable';
import type { ImpDatabase } from './open-database';
import type { ImpTransaction } from './with-imp-transaction';
import { withImpTransaction } from './with-imp-transaction';

const PRUNE_INTERVAL_MS = 3_600_000;

// keeps the event log to its retention: 7 days or 100,000 events, whichever keeps less
export function createEventLogPruner(
  db: ImpDatabase,
  now: () => number,
): ReconcilerDefinition<ImpTransaction> {
  return defineReconciler<ImpTransaction>({
    name: 'event-log-prune',
    intervalMs: PRUNE_INTERVAL_MS,
    reconcile: async () => {
      const removed = await withImpTransaction(db, (trx) => pruneEvents(trx, now()));

      return {
        outcome: removed > 0 ? 'changed' : 'unchanged',
        summary: `removed ${String(removed)} event(s)`,
      };
    },
  });
}
