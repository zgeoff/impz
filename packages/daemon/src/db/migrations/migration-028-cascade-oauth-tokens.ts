import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// a grant's delete takes its OAuth tokens with it. SQLite cannot add ON
// DELETE CASCADE in place, so a copy of the table replaces it, in its own
// transaction: Kysely runs a SQLite migration outside one.
export const MIGRATION_028_CASCADE_OAUTH_TOKENS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .createTable('oauth_tokens_cascade')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('grant_id', 'text', (c) =>
          c.notNull().references('oauth_grants.id').onDelete('cascade'),
        )
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('secret_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'integer', (c) => c.notNull())
        .addColumn('expires_at', 'integer', (c) => c.notNull())
        .addColumn('spent_at', 'integer')
        .execute();

      await sql`
        INSERT INTO oauth_tokens_cascade
          (id, grant_id, kind, secret_hash, created_at, expires_at, spent_at)
        SELECT id, grant_id, kind, secret_hash, created_at, expires_at, spent_at
        FROM oauth_tokens
      `.execute(trx);

      await trx.schema.dropTable('oauth_tokens').execute();
      await trx.schema.alterTable('oauth_tokens_cascade').renameTo('oauth_tokens').execute();

      await trx.schema
        .createIndex('oauth_tokens_grant_id')
        .on('oauth_tokens')
        .column('grant_id')
        .execute();

      await trx.schema
        .createIndex('oauth_tokens_expires_at')
        .on('oauth_tokens')
        .column('expires_at')
        .execute();
    });
  },
};
