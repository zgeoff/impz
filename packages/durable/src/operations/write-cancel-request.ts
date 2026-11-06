import type { DurableQueries } from '../durable-tables';

export async function writeCancelRequest(db: DurableQueries, id: string): Promise<boolean> {
  const result = await db
    .updateTable('operations')
    .set((eb) => ({ cancel_requested: 1, revision: eb('revision', '+', 1) }))
    .where('id', '=', id)
    .where('state', 'in', ['queued', 'running'])
    .where('cancel_requested', '=', 0)
    .executeTakeFirst();

  return result.numUpdatedRows === 1n;
}
