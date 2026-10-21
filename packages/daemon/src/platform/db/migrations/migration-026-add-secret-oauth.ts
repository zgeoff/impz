import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_026_ADD_SECRET_OAUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('secrets').addColumn('oauth', 'text').execute();
  },
};
