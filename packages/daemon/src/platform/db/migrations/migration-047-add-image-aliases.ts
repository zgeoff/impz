import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// The image id has no cascade, so a delete of an aliased image fails on the foreign key.
export const MIGRATION_047_ADD_IMAGE_ALIASES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('image_aliases')
      .addColumn('name', 'text', (column) => column.primaryKey())
      .addColumn('image_id', 'text', (column) => column.notNull().references('images.id'))
      .addColumn('updated_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex('image_aliases_image_id')
      .on('image_aliases')
      .column('image_id')
      .execute();
  },
};
