import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_010_ADD_IMAGE_SOURCE: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('images')

      .addColumn('source', 'text', (column) => column.notNull().defaultTo('oci'))
      .execute();

    await db.schema.alterTable('images').addColumn('source_imp', 'text').execute();

    await db.schema
      .alterTable('imps')

      .addColumn('identity_reset_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
};
