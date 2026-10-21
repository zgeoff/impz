import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_021_ADD_BROKER_SESSIONS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('broker_sessions')
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('generation', 'text', (column) => column.notNull())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addPrimaryKeyConstraint('broker_sessions_pk', ['imp_id', 'generation'])
      .execute();
  },
};
