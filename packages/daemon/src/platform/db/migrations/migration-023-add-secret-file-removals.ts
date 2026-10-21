import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_023_ADD_SECRET_FILE_REMOVALS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('secret_file_removals')
      .addColumn('value_file', 'text', (column) => column.primaryKey())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();
  },
};
