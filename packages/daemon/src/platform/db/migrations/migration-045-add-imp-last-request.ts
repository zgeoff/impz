import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_045_ADD_IMP_LAST_REQUEST: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('imps').addColumn('last_request_at', 'integer').execute();
  },
};
