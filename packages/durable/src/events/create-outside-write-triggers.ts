import { sql } from 'kysely';
import type { QueryExecutorProvider } from 'kysely';

const WRITES = ['INSERT', 'UPDATE', 'DELETE'] as const;

// A writer that appends no events, such as an older release of the program, still runs the
// database's triggers, so its write to a logged table leaves a mark for the next open. A migration
// would make that older release refuse the database.
export async function createOutsideWriteTriggers(
  db: QueryExecutorProvider,
  tables: readonly string[],
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS event_log_outside_writes (id INTEGER PRIMARY KEY CHECK (id = 1))
  `.execute(db);

  for (const table of tables) {
    for (const write of WRITES) {
      const name = sql.id(`durable_outside_${write.toLowerCase()}_${table}`);

      // dropped first, so a database keeps no trigger body from an older release of the program
      await sql`DROP TRIGGER IF EXISTS ${name}`.execute(db);

      await sql`
        CREATE TRIGGER ${name} AFTER ${sql.raw(write)} ON ${sql.table(table)}
        BEGIN
          INSERT OR IGNORE INTO event_log_outside_writes (id) VALUES (1);
        END
      `.execute(db);
    }
  }

  // a TEMP trigger lives only on this connection, and RAISE(IGNORE) drops the mark the triggers
  // above write, so the writes of the program that appends the events leave none
  await sql`
    CREATE TEMP TRIGGER IF NOT EXISTS durable_skip_own_writes
    BEFORE INSERT ON main.event_log_outside_writes
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `.execute(db);
}
