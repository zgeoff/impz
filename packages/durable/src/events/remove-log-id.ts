import type { DurableQueries } from '../durable-tables';

// A copy of the database leaves its log ID empty, so each open of a restored copy gives the log
// an ID of its own, however often the same copy is restored.
export async function removeLogID(db: DurableQueries): Promise<void> {
  await db.updateTable('event_log').set({ log_id: '' }).where('id', '=', 1).execute();
}
