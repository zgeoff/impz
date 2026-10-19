import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the allow-list of a `box` egress policy, as a JSON array
export const MIGRATION_007_ADD_EGRESS_ALLOW: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')
      .addColumn('egress_allow', 'text', (c) => c.notNull().defaultTo('[]'))
      .execute();
  },
};
