import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_004_ADD_API_AUDIT: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('api_audit')
      .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addColumn('procedure', 'text', (column) => column.notNull())
      .addColumn('actor', 'text', (column) => column.notNull())

      .addColumn('imp_name', 'text')
      .addColumn('outcome', 'text', (column) => column.notNull())
      .addColumn('duration_ms', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex('api_audit_imp_name')
      .on('api_audit')
      .columns(['imp_name', 'id'])
      .execute();
  },
};
