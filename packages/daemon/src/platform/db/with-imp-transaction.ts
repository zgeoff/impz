import type { Transaction } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';

export type ImpTransaction = Transaction<DB>;

// Each write that appends an event runs here: the readers of the log learn of the event only
// once its row is committed.
export async function withImpTransaction<T>(
  db: ImpDatabase,
  run: (trx: ImpTransaction) => Promise<T>,
): Promise<T> {
  const result = await db.transaction().execute(run);

  db.log.changes.notify();

  return result;
}
