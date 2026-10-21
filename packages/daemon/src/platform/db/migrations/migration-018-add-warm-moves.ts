import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_018_ADD_WARM_MOVES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('move_sends')

      .addColumn('warm', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('imps')

      .addColumn('trust_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
};
