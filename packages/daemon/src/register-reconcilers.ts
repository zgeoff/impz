import { createOperationRunner, createReconcilerRunner } from '@impz/durable';
import type { ReconcilerRunner } from '@impz/durable';
import { createEventLogPruner } from './platform/db/create-event-log-pruner';
import type { ImpDatabase } from './platform/db/open-database';
import type { ImpTransaction } from './platform/db/with-imp-transaction';
import { getImpdLogger } from './platform/process/get-impd-logger';
import { startRealTimer } from './platform/process/start-real-timer';

interface ReconcilerDeps {
  readonly db: ImpDatabase;
  readonly now: () => number;
}

// every reconciler impd runs, in one table
export function registerReconcilers(deps: ReconcilerDeps): ReconcilerRunner {
  const log = getImpdLogger('events');

  const withTransaction = <T>(run: (trx: ImpTransaction) => Promise<T>): Promise<T> =>
    deps.db.transaction().execute(run);

  const operations = createOperationRunner({
    withTransaction,
    definitions: [],
    changes: deps.db.log.changes,
    now: deps.now,
    log,
  });

  return createReconcilerRunner({
    reconcilers: [createEventLogPruner(deps.db, deps.now)],
    withTransaction,
    startOperation: operations.start,
    log,
    now: deps.now,
    random: Math.random,
    startTimer: startRealTimer,
  });
}
