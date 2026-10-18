import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// a refreshing oauth secret kind (GEO-121): the token endpoint and client
// its refresh token belongs to; null for every other kind
export const MIGRATION_026_ADD_SECRET_OAUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    // OAuthConfig as JSON ({ tokenUrl, clientId, tokenFormat }); null unless kind
    // is oauth
    await db.schema.alterTable('secrets').addColumn('oauth', 'text').execute();
  },
};
