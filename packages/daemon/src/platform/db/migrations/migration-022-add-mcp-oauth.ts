import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_022_ADD_MCP_OAUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('oauth_clients')

      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())

      .addColumn('redirect_uris', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('oauth_grants')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('client_id', 'text', (column) => column.notNull().references('oauth_clients.id'))
      .addColumn('token_id', 'text', (column) => column.notNull().references('tokens.id'))
      .addColumn('scope', 'text', (column) => column.notNull())

      .addColumn('imps', 'text')

      .addColumn('resource', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('last_used_at', 'integer')
      .execute();

    await db.schema
      .createTable('oauth_tokens')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('grant_id', 'text', (column) => column.notNull().references('oauth_grants.id'))
      .addColumn('kind', 'text', (column) => column.notNull())

      .addColumn('secret_hash', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('expires_at', 'integer', (column) => column.notNull())
      .addColumn('spent_at', 'integer')
      .execute();

    await db.schema
      .createIndex('oauth_grants_token_id')
      .on('oauth_grants')
      .column('token_id')
      .execute();

    await db.schema
      .createIndex('oauth_grants_client_id')
      .on('oauth_grants')
      .column('client_id')
      .execute();

    await db.schema
      .createIndex('oauth_tokens_grant_id')
      .on('oauth_tokens')
      .column('grant_id')
      .execute();

    await db.schema
      .createIndex('oauth_tokens_expires_at')
      .on('oauth_tokens')
      .column('expires_at')
      .execute();
  },
};
