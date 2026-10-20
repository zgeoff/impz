import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// public imps (#52): who reaches https://<name>.<domain>, and the hash of
// the token or password a public imp asks for
export const MIGRATION_011_ADD_PUBLIC_EXPOSURE: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      // `tailnet` or `public` (docs/guides/https.md#public-imps); a public imp's
      // auth (`none`, `token`, `basic`), basic's user, and the sha256 of the
      // token or password, base64url
      .addColumn('exposure', 'text', (c) => c.notNull().defaultTo('tailnet'))
      .execute();

    await db.schema.alterTable('imps').addColumn('public_auth', 'text').execute();
    await db.schema.alterTable('imps').addColumn('public_user', 'text').execute();
    await db.schema.alterTable('imps').addColumn('public_hash', 'text').execute();
  },
};
