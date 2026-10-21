import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_008_ADD_TOKEN_SSH_KEYS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('token_ssh_keys')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('token_id', 'text', (column) => column.notNull().references('tokens.id'))

      .addColumn('fingerprint', 'text', (column) => column.notNull().unique())

      .addColumn('public_key', 'text', (column) => column.notNull())
      .addColumn('comment', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createIndex('token_ssh_keys_token_id')
      .on('token_ssh_keys')
      .column('token_id')
      .execute();
  },
};
