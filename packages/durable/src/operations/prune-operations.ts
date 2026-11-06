import type { DurableTransaction } from '../durable-tables';
import { RETRY_KEY_KEEP_MS } from './pick-retry-outcome';

const OPERATION_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneOperations(trx: DurableTransaction, now: number): Promise<number> {
  await trx
    .updateTable('operations')
    .set({ retry_key: null })
    .where('retry_key', 'is not', null)
    .where('ended_at', '<=', now - RETRY_KEY_KEEP_MS)
    .execute();

  const ended = trx
    .selectFrom('operations')
    .select('id')
    .where('ended_at', '<=', now - OPERATION_KEEP_MS);

  await trx.deleteFrom('operation_steps').where('operation_id', 'in', ended).execute();

  const removed = await trx
    .deleteFrom('operations')
    .where('ended_at', '<=', now - OPERATION_KEEP_MS)
    .executeTakeFirstOrThrow();

  return Number(removed.numDeletedRows);
}
