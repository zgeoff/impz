import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_038_ADD_IMAGE_REMOVALS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('image_removals')
      .addColumn('digest', 'text', (column) => column.primaryKey())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();
  },
};
