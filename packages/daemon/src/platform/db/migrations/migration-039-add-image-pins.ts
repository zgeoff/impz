import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_039_ADD_IMAGE_PINS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('images')
      .addColumn('pinned', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
};
