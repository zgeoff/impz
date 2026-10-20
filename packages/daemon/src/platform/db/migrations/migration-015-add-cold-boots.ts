import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the last cold boots of each imp, which end its sessions' output
// generations, and the cause its next one has when impd knows it early
export const MIGRATION_015_ADD_COLD_BOOTS: Migration = {
  async up(db: Kysely<NoTables>) {
    // an imp's last cold boots (docs/architecture/guest/sessions.md#generations-boots-and-offsets)
    await db.schema
      .createTable('imp_cold_boots')

      // the order impd recorded them in: `at` can tie within a millisecond
      .addColumn('seq', 'integer', (column) => column.primaryKey().autoIncrement())
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('boot_id', 'text', (column) => column.notNull())
      .addColumn('cause', 'text', (column) => column.notNull())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addUniqueConstraint('imp_cold_boots_imp_boot', ['imp_id', 'boot_id'])
      .execute();

    // the cause the next cold boot records, when impd knew it before the
    // boot: `recovery`, `wake_fallback` or `restore`
    await db.schema.alterTable('imps').addColumn('next_boot_cause', 'text').execute();
  },
};
