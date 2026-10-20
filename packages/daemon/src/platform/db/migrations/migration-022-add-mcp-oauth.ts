import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// OAuth for the public MCP route (#127): the clients an operator adds,
// the grants people approve, and each grant's access and refresh tokens.
// 021 is #177's broker sessions.
export const MIGRATION_022_ADD_MCP_OAUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    // a public client of the MCP route (docs/guides/mcp.md#public-route)
    await db.schema
      .createTable('oauth_clients')

      // the client_id a connector holds
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())

      // a JSON array, each matched exactly
      .addColumn('redirect_uris', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    // what one approval gave one client: never wider than token_id, whose
    // removal removes it
    await db.schema
      .createTable('oauth_grants')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('client_id', 'text', (column) => column.notNull().references('oauth_clients.id'))
      .addColumn('token_id', 'text', (column) => column.notNull().references('tokens.id'))
      .addColumn('scope', 'text', (column) => column.notNull())

      // a JSON array of grant patterns; null for every imp and the host
      .addColumn('imps', 'text')

      // the resource its tokens are bound to, `<origin>/mcp`
      .addColumn('resource', 'text', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('last_used_at', 'integer')
      .execute();

    // an access or refresh token; a spent refresh token stays until it expires,
    // so a second use of it is known for a replay
    await db.schema
      .createTable('oauth_tokens')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('grant_id', 'text', (column) => column.notNull().references('oauth_grants.id'))
      .addColumn('kind', 'text', (column) => column.notNull())

      // SHA-256 of the secret, in hex
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
