import type { Transaction } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';

export type ImpTransaction = Transaction<DB>;

// Each write that appends an event runs here: the readers of the log learn of the event only
// once its row is committed. `at` is impd's clock as the transaction starts, the time of its events.
export async function withImpTransaction<T>(
  db: ImpDatabase,
  run: (trx: ImpTransaction, at: number) => Promise<T>,
): Promise<T> {
  const at = db.log.now();

  const result = await db.transaction().execute((trx) => run(trx, at));

  db.log.changes.notify();

  return result;
}
