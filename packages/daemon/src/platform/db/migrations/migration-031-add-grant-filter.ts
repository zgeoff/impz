import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_031_ADD_GRANT_FILTER: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('grants')

      .addColumn('filter', 'text')
      .execute();
  },
};
