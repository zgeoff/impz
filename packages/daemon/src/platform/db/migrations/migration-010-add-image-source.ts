import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// templates: images made from an imp's disk (#22), and the identity reset
// an imp from one owes its first boot
export const MIGRATION_010_ADD_IMAGE_SOURCE: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('images')

      // `oci` from docker, `imp` a template from an imp's disk
      .addColumn('source', 'text', (column) => column.notNull().defaultTo('oci'))
      .execute();

    // a template's source imp, by name: a token must reach it to copy its disk
    await db.schema.alterTable('images').addColumn('source_imp', 'text').execute();

    await db.schema
      .alterTable('imps')

      // 1 until the first cold boot of an imp from a template gives it its own
      // machine-id and ssh host keys
      .addColumn('identity_reset_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
};
