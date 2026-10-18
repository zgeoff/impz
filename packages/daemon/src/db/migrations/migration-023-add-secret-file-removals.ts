import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// each value file a delete or a replace displaced, written in its
// transaction and cleared once the file is gone, so a crash between the
// two leaves a record the next start finishes
export const MIGRATION_023_ADD_SECRET_FILE_REMOVALS: Migration = {
  async up(db: Kysely<NoTables>) {
    // A value file a committed delete or replace displaced, until it is removed
    await db.schema
      .createTable('secret_file_removals')
      .addColumn('value_file', 'text', (c) => c.primaryKey())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();
  },
};
