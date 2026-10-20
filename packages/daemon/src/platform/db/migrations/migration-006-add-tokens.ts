import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// named API tokens with scopes (#29), and who made each audited call
export const MIGRATION_006_ADD_TOKENS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('tokens')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())

      // SHA-256 of the secret, in hex; the secret itself is never stored
      .addColumn('secret_hash', 'text', (column) => column.notNull())
      .addColumn('scope', 'text', (column) => column.notNull())

      // a JSON array of imp patterns; null for every imp and the host
      .addColumn('imps', 'text')
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    // null on rows from before named tokens
    await db.schema.alterTable('api_audit').addColumn('actor_name', 'text').execute();
  },
};
