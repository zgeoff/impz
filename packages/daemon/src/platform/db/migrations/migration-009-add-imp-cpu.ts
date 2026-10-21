import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_009_ADD_IMP_CPU: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('imps').addColumn('cpu_limit', 'real').execute();

    await db.schema
      .alterTable('imps')
      .addColumn('cpu_weight', 'integer', (column) => column.notNull().defaultTo(100))
      .execute();

    await db.schema
      .alterTable('imps')
      .addColumn('wake_count', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('imps')

      .addColumn('awake_ms', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema.alterTable('imps').addColumn('awake_since', 'integer').execute();
  },
};
