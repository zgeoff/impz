import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_032_ADD_IMP_OOPS_BOOT_ID: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      .addColumn('oops_boot_id', 'text')
      .execute();
  },
};
