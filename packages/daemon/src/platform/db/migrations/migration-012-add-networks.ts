import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// private networks between imps (#31); a destroyed imp or network takes
// its memberships with it
export const MIGRATION_012_ADD_NETWORKS: Migration = {
  async up(db: Kysely<NoTables>) {
    // a private network between imps (docs/guides/networks.md)
    await db.schema
      .createTable('networks')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull().unique())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('network_members')
      .addColumn('network_id', 'text', (c) =>
        c.notNull().references('networks.id').onDelete('cascade'),
      )
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addPrimaryKeyConstraint('network_members_pk', ['network_id', 'imp_id'])
      .execute();

    await db.schema
      .createIndex('network_members_imp_id')
      .on('network_members')
      .column('imp_id')
      .execute();
  },
};
