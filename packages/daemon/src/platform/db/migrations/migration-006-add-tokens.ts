import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_006_ADD_TOKENS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('tokens')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())

      .addColumn('secret_hash', 'text', (column) => column.notNull())
      .addColumn('scope', 'text', (column) => column.notNull())

      .addColumn('imps', 'text')
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema.alterTable('api_audit').addColumn('actor_name', 'text').execute();
  },
};
