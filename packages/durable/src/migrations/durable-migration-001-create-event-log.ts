import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

type NoTables = Record<string, never>;

export const DURABLE_MIGRATION_001_CREATE_EVENT_LOG: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('events')
      .addColumn('seq', 'integer', (column) => column.primaryKey().autoIncrement())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addColumn('kind', 'text', (column) => column.notNull())
      .addColumn('target_id', 'text')
      .addColumn('operation_id', 'text')
      .addColumn('payload', 'text', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('event_log')
      .addColumn('id', 'integer', (column) => column.primaryKey().check(sql`id = 1`))
      .addColumn('log_id', 'text', (column) => column.notNull())
      .addColumn('pruned_through', 'integer', (column) => column.notNull())
      .execute();

    await sql`
      INSERT INTO event_log (id, log_id, pruned_through) VALUES (1, ${crypto.randomUUID()}, 0)
    `.execute(db);
  },
};
