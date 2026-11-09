import { sql } from 'kysely';
import type { QueryExecutorProvider } from 'kysely';

const WRITES = ['INSERT', 'UPDATE', 'DELETE'] as const;

// A writer that appends no events, such as an older release of the program, still runs the
// database's triggers, so its write to a logged table empties the log ID and the next open gives the
// log a new one. A migration would make that older release refuse the database.
export async function createOutsideWriteTriggers(
  db: QueryExecutorProvider,
  tables: readonly string[],
): Promise<void> {
  for (const table of tables) {
    for (const write of WRITES) {
      await sql`
        CREATE TRIGGER IF NOT EXISTS ${sql.id(`durable_outside_${write.toLowerCase()}_${table}`)}
        AFTER ${sql.raw(write)} ON ${sql.table(table)}
        BEGIN
          UPDATE event_log SET log_id = '' WHERE id = 1 AND log_id <> '';
        END
      `.execute(db);
    }
  }

  // a TEMP trigger lives only on this connection, and RAISE(IGNORE) drops the update the triggers
  // above make, so the writes of the program that appends the events keep the log ID
  await sql`
    CREATE TEMP TRIGGER IF NOT EXISTS durable_keep_log_id
    BEFORE UPDATE OF log_id ON main.event_log
    WHEN NEW.log_id = ''
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `.execute(db);
}
