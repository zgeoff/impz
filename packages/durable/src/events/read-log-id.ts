import type { DurableQueries } from '../durable-tables';

export async function readLogID(db: DurableQueries): Promise<string> {
  const row = await db
    .selectFrom('event_log')
    .select('log_id')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();

  return row.log_id;
}
