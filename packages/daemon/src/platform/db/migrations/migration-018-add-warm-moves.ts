import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// warm moves (#86): which sends carry the memory, and an imp whose first
// wake on its new host installs this host's broker CA
export const MIGRATION_018_ADD_WARM_MOVES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('move_sends')

      // 1 when the memory snapshot goes too: a warm move
      .addColumn('warm', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('imps')

      // 1 from a warm move's commit to the imp's first wake here, which installs
      // this host's broker CA in the guest
      .addColumn('trust_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
  },
};
