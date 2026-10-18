import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the kernel oops hold in a column of its own (GEO-1059), copied from the
// error text an older impd kept it in; the error column stays as it is
export const MIGRATION_033_ADD_IMP_OOPS_HOLD: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .alterTable('imps')

        // 1 while a kernel oops holds the imp's disk, until a reboot frees it
        .addColumn('oops_hold', 'integer', (c) => c.notNull().defaultTo(0))
        .execute();

      // the text KERNEL_OOPS_TRIGGER held when this migration was written
      await sql`
        UPDATE imps SET oops_hold = 1 WHERE error = 'a kernel oops killed firecracker'
      `.execute(trx);
    });
  },
};
