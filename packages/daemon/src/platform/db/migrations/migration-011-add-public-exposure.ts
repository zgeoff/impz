import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_011_ADD_PUBLIC_EXPOSURE: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      .addColumn('exposure', 'text', (column) => column.notNull().defaultTo('tailnet'))
      .execute();

    await db.schema.alterTable('imps').addColumn('public_auth', 'text').execute();
    await db.schema.alterTable('imps').addColumn('public_user', 'text').execute();
    await db.schema.alterTable('imps').addColumn('public_hash', 'text').execute();
  },
};
