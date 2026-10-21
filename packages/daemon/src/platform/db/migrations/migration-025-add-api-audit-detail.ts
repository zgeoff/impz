import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_025_ADD_API_AUDIT_DETAIL: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('api_audit').addColumn('detail', 'text').execute();
  },
};
