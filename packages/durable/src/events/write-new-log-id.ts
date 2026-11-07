import type { DurableQueries } from '../durable-tables';

export async function writeNewLogId(db: DurableQueries): Promise<string> {
  const logId = crypto.randomUUID();

  await db.updateTable('event_log').set({ log_id: logId }).where('id', '=', 1).execute();

  return logId;
}
