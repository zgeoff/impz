import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_003_ADD_BROKER: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      .addColumn('egress_policy', 'text', (column) => column.notNull().defaultTo('open'))
      .execute();

    await db.schema
      .createTable('secrets')
      .addColumn('name', 'text', (column) => column.primaryKey())
      .addColumn('kind', 'text', (column) => column.notNull())

      .addColumn('rules', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('grants')
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('secret_name', 'text', (column) =>
        column.notNull().references('secrets.name').onDelete('cascade'),
      )
      .addPrimaryKeyConstraint('grants_pk', ['imp_id', 'secret_name'])
      .execute();

    await db.schema
      .createTable('broker_audit')
      .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('secret_name', 'text', (column) => column.notNull())
      .addColumn('at', 'integer', (column) => column.notNull())
      .addColumn('method', 'text', (column) => column.notNull())
      .addColumn('host', 'text', (column) => column.notNull())
      .addColumn('path', 'text', (column) => column.notNull())
      .addColumn('status', 'integer', (column) => column.notNull())
      .addColumn('request_bytes', 'integer', (column) => column.notNull())
      .addColumn('response_bytes', 'integer', (column) => column.notNull())
      .addColumn('duration_ms', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex('broker_audit_imp_id')
      .on('broker_audit')
      .columns(['imp_id', 'id'])
      .execute();
  },
};
