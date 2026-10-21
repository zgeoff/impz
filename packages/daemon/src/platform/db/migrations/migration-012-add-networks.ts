import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_012_ADD_NETWORKS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('networks')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('network_members')
      .addColumn('network_id', 'text', (column) =>
        column.notNull().references('networks.id').onDelete('cascade'),
      )
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addPrimaryKeyConstraint('network_members_pk', ['network_id', 'imp_id'])
      .execute();

    await db.schema
      .createIndex('network_members_imp_id')
      .on('network_members')
      .column('imp_id')
      .execute();
  },
};
