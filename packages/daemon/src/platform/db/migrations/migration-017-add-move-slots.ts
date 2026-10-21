import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_017_ADD_MOVE_SLOTS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('move_tickets').addColumn('slot', 'integer').execute();
  },
};
