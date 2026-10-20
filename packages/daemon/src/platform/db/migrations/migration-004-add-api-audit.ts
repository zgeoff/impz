import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the API audit log: calls that change something, and sessions opened
export const MIGRATION_004_ADD_API_AUDIT: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('api_audit')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('at', 'integer', (c) => c.notNull())
      .addColumn('procedure', 'text', (c) => c.notNull())
      .addColumn('actor', 'text', (c) => c.notNull())

      // the name, not a reference: a destroyed imp's rows stay
      .addColumn('imp_name', 'text')
      .addColumn('outcome', 'text', (c) => c.notNull())
      .addColumn('duration_ms', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex('api_audit_imp_name')
      .on('api_audit')
      .columns(['imp_name', 'id'])
      .execute();
  },
};
