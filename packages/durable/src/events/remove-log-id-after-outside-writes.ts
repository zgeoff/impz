import type { DurableQueries } from '../durable-tables';

// a crash between the two writes leaves the mark, which costs the readers one more reset at most
export async function removeLogIdAfterOutsideWrites(db: DurableQueries): Promise<void> {
  await db
    .updateTable('event_log')
    .set({ log_id: '' })
    .where('id', '=', 1)
    .where((eb) => eb.exists(eb.selectFrom('event_log_outside_writes').select('id')))
    .execute();

  await db.deleteFrom('event_log_outside_writes').execute();
}
