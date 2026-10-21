import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_027_ADD_IMP_BACKUP: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      .addColumn('backup', 'integer', (column) => column.notNull().defaultTo(1))
      .execute();
  },
};
