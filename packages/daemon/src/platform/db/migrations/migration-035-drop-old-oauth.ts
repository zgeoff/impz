import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_035_DROP_OLD_OAUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      // each table before the one it references
      await trx.schema.dropTable('oauth_tokens').execute();
      await trx.schema.dropTable('oauth_grants').execute();
      await trx.schema.dropTable('oauth_clients').execute();
    });
  },
};
