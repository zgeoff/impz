import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

type NoTables = Record<string, never>;

export const DURABLE_MIGRATION_003_CREATE_RECONCILERS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('reconcilers')
      .addColumn('name', 'text', (column) => column.primaryKey())
      .addColumn('outcome', 'text', (column) => column.notNull())
      .addColumn('summary', 'text', (column) => column.notNull())
      .addColumn('consecutive_errors', 'integer', (column) => column.notNull())
      .addColumn('at', 'integer', (column) => column.notNull())
      .execute();
  },
};
