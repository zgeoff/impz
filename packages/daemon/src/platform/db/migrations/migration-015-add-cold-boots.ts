import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_015_ADD_COLD_BOOTS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('imp_cold_boots')

      // `at` can tie within a millisecond, so seq keeps the order impd recorded
      // them in
      .addColumn('seq', 'integer', (column) => column.primaryKey().autoIncrement())
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('boot_id', 'text', (column) => column.notNull())
      .addColumn('cause', 'text', (column) => column.notNull())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addUniqueConstraint('imp_cold_boots_imp_boot', ['imp_id', 'boot_id'])
      .execute();

    await db.schema.alterTable('imps').addColumn('next_boot_cause', 'text').execute();
  },
};
