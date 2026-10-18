import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the boot a kernel oops held the imp's disk in (GEO-908)
export const MIGRATION_032_ADD_IMP_OOPS_BOOT_ID: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      // the kernel's boot id when the oops hold began; null on an imp
      // without one, and on a hold from before this column
      .addColumn('oops_boot_id', 'text')
      .execute();
  },
};
