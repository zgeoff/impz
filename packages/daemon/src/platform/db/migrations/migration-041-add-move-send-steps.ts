import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_041_ADD_MOVE_SEND_STEPS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('move_sends')

      .addColumn('step', 'text', (column) => column.notNull().defaultTo('prepared'))
      .execute();

    await db.schema
      .alterTable('move_sends')

      .addColumn('halted', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    // A send in flight at the upgrade keeps the step its marks show.
    await sql`
      UPDATE move_sends SET step = CASE
        WHEN (SELECT move_state FROM imps WHERE imps.id = move_sends.imp_id) = 'moved' THEN 'sent'
        WHEN peer_url IS NOT NULL THEN 'streaming'
        ELSE 'prepared'
      END
    `.execute(db);
  },
};
