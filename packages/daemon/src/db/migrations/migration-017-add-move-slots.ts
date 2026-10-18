import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// warm moves (#86): the slot a ticket keeps for the imp it brings
export const MIGRATION_017_ADD_MOVE_SLOTS: Migration = {
  async up(db: Kysely<NoTables>) {
    // a warm move's slot, which no other imp takes until the commit
    await db.schema.alterTable('move_tickets').addColumn('slot', 'integer').execute();
  },
};
