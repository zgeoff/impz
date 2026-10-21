import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_033_ADD_IMP_OOPS_HOLD: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .alterTable('imps')

        .addColumn('oops_hold', 'integer', (column) => column.notNull().defaultTo(0))
        .execute();

      // the oops text impd matched when this migration was written
      await sql`
        UPDATE imps SET oops_hold = 1 WHERE error = 'a kernel oops killed firecracker'
      `.execute(trx);
    });
  },
};
