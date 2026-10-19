import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// SSH keys bound to tokens (#63); impd deletes a token's keys with it
export const MIGRATION_008_ADD_TOKEN_SSH_KEYS: Migration = {
  async up(db: Kysely<NoTables>) {
    // an SSH key bound to a token (docs/guides/ssh.md#keys-bound-to-tokens)
    await db.schema
      .createTable('token_ssh_keys')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('token_id', 'text', (c) => c.notNull().references('tokens.id'))

      // `SHA256:<base64>` of the key blob; a key binds to one token at most
      .addColumn('fingerprint', 'text', (c) => c.notNull().unique())

      // `<type> <base64>`, without the comment
      .addColumn('public_key', 'text', (c) => c.notNull())
      .addColumn('comment', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex('token_ssh_keys_token_id')
      .on('token_ssh_keys')
      .column('token_id')
      .execute();
  },
};
