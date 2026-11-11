import type { DurableQueries } from '../durable-tables';

// only a log whose ID a copy removed takes a new one, so a log keeps its ID across restarts
export async function writeNewLogID(db: DurableQueries): Promise<void> {
  await db
    .updateTable('event_log')
    .set({ log_id: crypto.randomUUID() })
    .where('id', '=', 1)
    .where('log_id', '=', '')
    .execute();
}
