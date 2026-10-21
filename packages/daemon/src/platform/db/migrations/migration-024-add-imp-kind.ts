import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_024_ADD_IMP_KIND: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')
      .addColumn('kind', 'text', (column) => column.notNull().defaultTo('user'))
      .execute();
  },
};
